// lib/shopify.ts - Shopify Admin GraphQL & REST API Client Engine
import crypto from 'crypto';
import axios from 'axios';
import { db } from './db';

export function verifyShopifyHmac(rawBody: string | Buffer, secret: string, hmacHeader: string | null): boolean {
  if (!rawBody || !secret || !hmacHeader) return false;
  try {
    const generatedHash = crypto
      .createHmac('sha256', secret)
      .update(rawBody)
      .digest('base64');
    return crypto.timingSafeEqual(Buffer.from(generatedHash), Buffer.from(hmacHeader));
  } catch (err) {
    return false;
  }
}

export function cleanShopDomain(url: string): string {
  if (!url) return '';
  return url.replace(/^https?:\/\//i, '').replace(/\/$/, '').trim();
}

export interface LineItemInfo {
  id: string;
  title: string;
  sku: string;
  quantity: number;
  productId: string;
  productTags: string;
  customSupplierMetafield?: string | null;
}

export interface ParsedOrder {
  id: string;
  name: string;
  email?: string;
  tags?: string;
  lineItems: LineItemInfo[];
}

// Extract supplier name from Product tags ("Supplier: Hamza") or custom.supplier metafield
export function extractSupplierName(tags: string, metafield?: string | null): string | null {
  if (metafield && metafield.trim() !== '') {
    return metafield.trim();
  }

  if (!tags) return null;

  // Split tags by comma
  const tagList = tags.split(',').map(t => t.trim());
  for (const tag of tagList) {
    const match = tag.match(/^Supplier:\s*(.+)$/i);
    if (match && match[1]) {
      return match[1].trim();
    }
  }

  return null;
}

// Fetch Full Order details using Shopify Admin GraphQL API
export async function getOrderDetailsGraphQL(shopDomain: string, accessToken: string, orderId: string): Promise<ParsedOrder | null> {
  const domain = cleanShopDomain(shopDomain);
  const formattedOrderId = orderId.startsWith('gid://') ? orderId : `gid://shopify/Order/${orderId}`;

  const query = `
    query getOrder($id: ID!) {
      order(id: $id) {
        id
        name
        email
        tags
        lineItems(first: 50) {
          edges {
            node {
              id
              title
              sku
              quantity
              product {
                id
                tags
                metafield(namespace: "custom", key: "supplier") {
                  value
                }
              }
            }
          }
        }
      }
    }
  `;

  try {
    const res = await axios.post(
      `https://${domain}/admin/api/2024-01/graphql.json`,
      { query, variables: { id: formattedOrderId } },
      {
        headers: { 'X-Shopify-Access-Token': accessToken },
        timeout: 10000
      }
    );

    const orderData = res.data?.data?.order;
    if (!orderData) return null;

    const lineItems: LineItemInfo[] = (orderData.lineItems?.edges || []).map((edge: any) => ({
      id: edge.node.id,
      title: edge.node.title,
      sku: edge.node.sku ? edge.node.sku.trim() : '',
      quantity: edge.node.quantity || 1,
      productId: edge.node.product?.id ? edge.node.product.id.split('/').pop() : '',
      productTags: Array.isArray(edge.node.product?.tags) ? edge.node.product.tags.join(', ') : (edge.node.product?.tags || ''),
      customSupplierMetafield: edge.node.product?.metafield?.value || null
    }));

    return {
      id: orderData.id,
      name: orderData.name,
      email: orderData.email,
      tags: Array.isArray(orderData.tags) ? orderData.tags.join(', ') : (orderData.tags || ''),
      lineItems
    };
  } catch (err: any) {
    await db.addLog('ERROR', `GraphQL order fetch failed for order ${orderId} on ${domain}: ${err.message}`, 'graphql', domain);
    return null;
  }
}

// Find Variant ID by SKU using GraphQL with REST Fallback
export async function findVariantIdBySku(shopDomain: string, accessToken: string, sku: string): Promise<{ variantId: string; inventoryItemId?: string } | null> {
  const cleanSku = sku.trim();
  const domain = cleanShopDomain(shopDomain);

  // 1. GraphQL Variant Lookup
  const query = `
    query findVariant($query: String!) {
      productVariants(first: 10, query: $query) {
        edges {
          node {
            id
            sku
            inventoryItem {
              id
            }
          }
        }
      }
    }
  `;

  try {
    const res = await axios.post(
      `https://${domain}/admin/api/2024-01/graphql.json`,
      { query, variables: { query: `sku:${cleanSku}` } },
      {
        headers: { 'X-Shopify-Access-Token': accessToken },
        timeout: 8000
      }
    );

    const edges = res.data?.data?.productVariants?.edges || [];
    for (const edge of edges) {
      if (edge.node?.sku && edge.node.sku.trim().toLowerCase() === cleanSku.toLowerCase()) {
        const gid = edge.node.id;
        const invGid = edge.node.inventoryItem?.id;
        return {
          variantId: gid ? gid.split('/').pop() : '',
          inventoryItemId: invGid ? invGid.split('/').pop() : undefined
        };
      }
    }
  } catch (err: any) {
    await db.addLog('WARN', `GraphQL variant query failed for SKU '${cleanSku}' on ${domain}: ${err.message}`, 'variant_lookup', domain);
  }

  // 2. REST Fallback
  try {
    const restRes = await axios.get(`https://${domain}/admin/api/2024-01/variants.json?sku=${encodeURIComponent(cleanSku)}`, {
      headers: { 'X-Shopify-Access-Token': accessToken },
      timeout: 8000
    });

    const variants = restRes.data?.variants || [];
    const match = variants.find((v: any) => v.sku && v.sku.trim().toLowerCase() === cleanSku.toLowerCase());
    if (match) {
      return {
        variantId: String(match.id),
        inventoryItemId: String(match.inventory_item_id)
      };
    }
  } catch (err: any) {
    await db.addLog('WARN', `REST variant query fallback failed for SKU '${cleanSku}' on ${domain}: ${err.message}`, 'variant_lookup', domain);
  }

  return null;
}

// Create B2B Supplier Order on Target Connected Store
export async function createSupplierFulfillmentOrder(
  supplierStore: { shopDomain: string; accessToken: string; ownerEmail: string; name: string },
  retailerStore: { shopDomain: string; name: string; supplierName: string },
  items: { sku: string; quantity: number }[],
  sourceOrderName: string
): Promise<{ success: boolean; orderId?: string; orderName?: string; error?: string }> {
  const domain = cleanShopDomain(supplierStore.shopDomain);
  const lineItemsPayload: any[] = [];

  for (const item of items) {
    const variant = await findVariantIdBySku(supplierStore.shopDomain, supplierStore.accessToken, item.sku);
    if (variant && variant.variantId) {
      lineItemsPayload.push({
        variant_id: variant.variantId,
        quantity: item.quantity
      });
    } else {
      await db.addLog('ERROR', `SKU '${item.sku}' not found on supplier store ${supplierStore.name}. Excluded from order.`, 'order_creation', supplierStore.shopDomain);
    }
  }

  if (lineItemsPayload.length === 0) {
    return {
      success: false,
      error: `None of the line item SKUs could be resolved on supplier store ${supplierStore.name}`
    };
  }

  const orderPayload = {
    order: {
      line_items: lineItemsPayload,
      email: supplierStore.ownerEmail,
      tags: `Automated Dropship, Soldby-${retailerStore.supplierName}`,
      financial_status: "pending",
      note: `Auto-generated B2B order for items sold in order ${sourceOrderName} on ${retailerStore.name}`
    }
  };

  try {
    const res = await axios.post(`https://${domain}/admin/api/2024-01/orders.json`, orderPayload, {
      headers: { 'X-Shopify-Access-Token': supplierStore.accessToken },
      timeout: 10000
    });

    const newOrder = res.data?.order;
    const orderName = newOrder?.name || `#${newOrder?.order_number}`;
    await db.addLog('INFO', `🎉 Successfully created supplier order ${orderName} on ${supplierStore.name} for source order ${sourceOrderName}`, 'order_creation', supplierStore.shopDomain);

    return {
      success: true,
      orderId: String(newOrder?.id),
      orderName: orderName
    };
  } catch (err: any) {
    const errorMsg = err.response ? JSON.stringify(err.response.data) : err.message;
    await db.addLog('ERROR', `Failed to create order on supplier store ${supplierStore.name}: ${errorMsg}`, 'order_creation', supplierStore.shopDomain);
    return {
      success: false,
      error: errorMsg
    };
  }
}

// Synchronize Inventory Quantities for Matching SKUs across stores
export async function syncInventoryAcrossStores(
  sourceShopDomain: string,
  sku: string,
  newQuantity: number
): Promise<void> {
  const stores = await db.getAllStores();
  const cleanSource = cleanShopDomain(sourceShopDomain);

  for (const store of stores) {
    if (store.shopDomain === cleanSource || !store.isActive) continue;

    const variant = await findVariantIdBySku(store.shopDomain, store.accessToken, sku);
    if (variant && variant.inventoryItemId) {
      try {
        const domain = cleanShopDomain(store.shopDomain);

        // Get primary location ID
        const locRes = await axios.get(`https://${domain}/admin/api/2024-01/locations.json`, {
          headers: { 'X-Shopify-Access-Token': store.accessToken },
          timeout: 8000
        });

        const locationId = locRes.data?.locations?.[0]?.id;
        if (!locationId) continue;

        // Set inventory level
        await axios.post(
          `https://${domain}/admin/api/2024-01/inventory_levels/set.json`,
          {
            location_id: locationId,
            inventory_item_id: variant.inventoryItemId,
            available: newQuantity
          },
          {
            headers: { 'X-Shopify-Access-Token': store.accessToken },
            timeout: 8000
          }
        );

        await db.addLog(
          'INFO',
          `Synced inventory for SKU '${sku}' on ${store.name} -> Available: ${newQuantity}`,
          'inventory_sync',
          store.shopDomain
        );
      } catch (err: any) {
        await db.addLog(
          'ERROR',
          `Failed to sync inventory for SKU '${sku}' on ${store.name}: ${err.message}`,
          'inventory_sync',
          store.shopDomain
        );
      }
    }
  }
}
