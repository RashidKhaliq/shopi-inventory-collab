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

// Fetch Orders from Shopify REST API for a given store (e.g. created today or all recent)
export async function fetchRecentOrdersREST(shopDomain: string, accessToken: string, createdMin?: string): Promise<any[]> {
  const domain = cleanShopDomain(shopDomain);
  if (!domain || !accessToken) return [];

  try {
    let url = `https://${domain}/admin/api/2024-01/orders.json?status=any&limit=50`;
    if (createdMin) {
      url += `&created_at_min=${encodeURIComponent(createdMin)}`;
    }

    const res = await axios.get(url, {
      headers: { 'X-Shopify-Access-Token': accessToken },
      timeout: 10000
    });

    return res.data?.orders || [];
  } catch (err: any) {
    await db.addLog('ERROR', `Failed to fetch recent orders from Shopify for ${domain}: ${err.message}`, 'orders_fetch', domain);
    return [];
  }
}

export interface LineItemInfo {
  id: string;
  title: string;
  sku: string;
  quantity: number;
  productId: string;
  productTags: string;
  customSupplierMetafield?: string | null;
  vendor?: string | null;
}

export interface ParsedOrder {
  id: string;
  name: string;
  email?: string;
  tags?: string;
  lineItems: LineItemInfo[];
}

// Extract supplier name from Product tags ("Supplier: Hamza"), custom.supplier metafield, or line item vendor
export function extractSupplierName(tags?: string | null, metafield?: string | null, vendor?: string | null): string | null {
  if (metafield && metafield.trim() !== '') {
    return metafield.trim();
  }

  if (tags && tags.trim() !== '') {
    const tagList = tags.split(',').map(t => t.trim());
    for (const tag of tagList) {
      // 1. Tag format: "Supplier: Rashid" or "Supplier: Store A" or "Supplier_Rashid"
      const match = tag.match(/^(?:Supplier|supplier)[:_\s]+(.+)$/i);
      if (match && match[1]) {
        return match[1].trim();
      }
    }

    // 2. Direct tag check if tag doesn't have "Supplier:" prefix (e.g. tag is "Rashid" or "Store A")
    for (const tag of tagList) {
      if (tag && tag.length > 1 && !tag.toLowerCase().startsWith('automated')) {
        return tag.trim();
      }
    }
  }

  // 3. Fallback to line item vendor if provided
  if (vendor && vendor.trim() !== '') {
    const cleanVendor = vendor.trim();
    const vendorMatch = cleanVendor.match(/^(?:Supplier|supplier)[:_\s]+(.+)$/i);
    return vendorMatch ? vendorMatch[1].trim() : cleanVendor;
  }

  return null;
}

// Fetch Product details via REST API if GraphQL order line items missing tags
export async function getProductDetailsREST(shopDomain: string, accessToken: string, productId: string): Promise<{ tags: string; vendor: string; supplierMetafield: string | null }> {
  const domain = cleanShopDomain(shopDomain);
  const cleanId = productId.replace(/^gid:\/\/shopify\/Product\//, '');
  if (!cleanId) return { tags: '', vendor: '', supplierMetafield: null };

  try {
    const res = await axios.get(`https://${domain}/admin/api/2024-01/products/${cleanId}.json`, {
      headers: { 'X-Shopify-Access-Token': accessToken },
      timeout: 8000
    });

    const product = res.data?.product;
    if (!product) return { tags: '', vendor: '', supplierMetafield: null };

    return {
      tags: Array.isArray(product.tags) ? product.tags.join(', ') : (product.tags || ''),
      vendor: product.vendor || '',
      supplierMetafield: null
    };
  } catch (err: any) {
    return { tags: '', vendor: '', supplierMetafield: null };
  }
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
              vendor
              product {
                id
                tags
                vendor
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
      customSupplierMetafield: edge.node.product?.metafield?.value || null,
      vendor: edge.node.vendor || edge.node.product?.vendor || ''
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
  if (!cleanSku) return null;
  const domain = cleanShopDomain(shopDomain);

  // 1. GraphQL Variant Lookup
  const query = `
    query findVariant($query: String!) {
      productVariants(first: 20, query: $query) {
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
      { query, variables: { query: `sku:"${cleanSku.replace(/"/g, '\\"')}"` } },
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
          variantId: gid ? gid.split('/').pop()! : '',
          inventoryItemId: invGid ? invGid.split('/').pop() : undefined
        };
      }
    }
  } catch (err: any) {
    await db.addLog('WARN', `GraphQL variant query failed for SKU '${cleanSku}' on ${domain}: ${err.message}`, 'variant_lookup', domain);
  }

  // 2. REST Fallback via Products List (scanning variants)
  try {
    const restRes = await axios.get(`https://${domain}/admin/api/2024-01/products.json?limit=250&fields=id,title,variants`, {
      headers: { 'X-Shopify-Access-Token': accessToken },
      timeout: 10000
    });

    const products = restRes.data?.products || [];
    for (const prod of products) {
      for (const v of (prod.variants || [])) {
        if (v.sku && v.sku.trim().toLowerCase() === cleanSku.toLowerCase()) {
          return {
            variantId: String(v.id),
            inventoryItemId: String(v.inventory_item_id)
          };
        }
      }
    }
  } catch (err: any) {
    await db.addLog('WARN', `REST products search fallback failed for SKU '${cleanSku}' on ${domain}: ${err.message}`, 'variant_lookup', domain);
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
      const parsedId = parseInt(variant.variantId, 10);
      lineItemsPayload.push({
        variant_id: isNaN(parsedId) ? variant.variantId : parsedId,
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

  const recipientEmail = supplierStore.ownerEmail && supplierStore.ownerEmail.includes('@')
    ? supplierStore.ownerEmail
    : 'orders@dropship-sync.com';

  const orderPayload = {
    order: {
      line_items: lineItemsPayload,
      email: recipientEmail,
      tags: `Automated Dropship, Soldby-${retailerStore.supplierName}`,
      financial_status: "pending",
      inventory_behaviour: "decrement_obeying_policy",
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
