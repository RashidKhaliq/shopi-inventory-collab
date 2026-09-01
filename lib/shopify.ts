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

// Extract supplier name from custom.supplier metafield, Supplier: Name tags, or line item vendor
export function extractSupplierName(tags?: string | null, metafield?: string | null, vendor?: string | null): string | null {
  // 1. Primary Identifier: custom.supplier metafield
  if (metafield && typeof metafield === 'string' && metafield.trim() !== '') {
    return metafield.trim();
  }

  // 2. Secondary Identifier: Supplier: <Name> tag (case-insensitive)
  if (tags && typeof tags === 'string' && tags.trim() !== '') {
    const tagList = tags.split(',').map(t => t.trim());
    for (const tag of tagList) {
      const match = tag.match(/^(?:Supplier|supplier)[:_\s]+(.+)$/i);
      if (match && match[1]) {
        return match[1].trim();
      }
    }
  }

  // 3. Fallback: Line item vendor matching Supplier: <Name>
  if (vendor && typeof vendor === 'string' && vendor.trim() !== '') {
    const cleanVendor = vendor.trim();
    const vendorMatch = cleanVendor.match(/^(?:Supplier|supplier)[:_\s]+(.+)$/i);
    if (vendorMatch && vendorMatch[1]) {
      return vendorMatch[1].trim();
    }
  }

  return null;
}

// Fetch Product details & custom.supplier Metafield via REST API
export async function getProductDetailsREST(
  shopDomain: string,
  accessToken: string,
  productId: string
): Promise<{ tags: string; vendor: string; supplierMetafield: string | null }> {
  const domain = cleanShopDomain(shopDomain);
  const cleanId = productId.replace(/^gid:\/\/shopify\/Product\//, '');
  if (!cleanId) return { tags: '', vendor: '', supplierMetafield: null };

  let tags = '';
  let vendor = '';
  let supplierMetafield: string | null = null;

  try {
    const res = await axios.get(`https://${domain}/admin/api/2024-01/products/${cleanId}.json`, {
      headers: { 'X-Shopify-Access-Token': accessToken },
      timeout: 8000
    });

    const product = res.data?.product;
    if (product) {
      tags = Array.isArray(product.tags) ? product.tags.join(', ') : (product.tags || '');
      vendor = product.vendor || '';
    }
  } catch (err: any) {
    // Ignore REST product lookup error
  }

  // Fetch product metafields for custom.supplier
  try {
    const metaRes = await axios.get(`https://${domain}/admin/api/2024-01/products/${cleanId}/metafields.json`, {
      headers: { 'X-Shopify-Access-Token': accessToken },
      timeout: 8000
    });

    const metafields = metaRes.data?.metafields || [];
    const found = metafields.find((m: any) =>
      (m.namespace === 'custom' && m.key === 'supplier') || m.key === 'supplier'
    );
    if (found && found.value) {
      supplierMetafield = String(found.value).trim();
    }
  } catch (err: any) {
    // Ignore REST metafield error
  }

  return { tags, vendor, supplierMetafield };
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
export async function findVariantIdBySku(
  shopDomain: string,
  accessToken: string,
  sku: string
): Promise<{ variantId: string; inventoryItemId?: string; availableQuantity?: number } | null> {
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
            inventoryQuantity
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
          inventoryItemId: invGid ? invGid.split('/').pop() : undefined,
          availableQuantity: edge.node.inventoryQuantity ?? undefined
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
            inventoryItemId: String(v.inventory_item_id),
            availableQuantity: v.inventory_quantity
          };
        }
      }
    }
  } catch (err: any) {
    await db.addLog('WARN', `REST products search fallback failed for SKU '${cleanSku}' on ${domain}: ${err.message}`, 'variant_lookup', domain);
  }

  return null;
}

// Create B2B Supplier Order on Target Connected Store (Store B sells Store A's product)
export async function createSupplierFulfillmentOrder(
  supplierStore: { shopDomain: string; accessToken: string; ownerEmail: string; name: string },
  retailerStore: { shopDomain: string; name: string; supplierName: string; ownerEmail?: string },
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

  // Set order customer email & name to Seller Store details (Store B)
  const sellerEmail = retailerStore.ownerEmail && retailerStore.ownerEmail.includes('@')
    ? retailerStore.ownerEmail
    : 'seller@dropship-sync.com';

  const sellerStoreName = retailerStore.name || `Store ${retailerStore.supplierName}`;

  const orderPayload = {
    order: {
      line_items: lineItemsPayload,
      customer: {
        first_name: sellerStoreName,
        last_name: "(Seller Store)",
        email: sellerEmail
      },
      email: sellerEmail,
      source_name: "Dropshipping",
      tags: `Automated Dropship, Dropshipping, Soldby-${retailerStore.supplierName || sellerStoreName}`,
      financial_status: "pending",
      inventory_behaviour: "decrement_obeying_policy",
      note: `Dropshipping order placed by ${sellerStoreName} (${retailerStore.shopDomain}) for original order #${sourceOrderName}.`
    }
  };

  try {
    const res = await axios.post(`https://${domain}/admin/api/2024-01/orders.json`, orderPayload, {
      headers: { 'X-Shopify-Access-Token': supplierStore.accessToken },
      timeout: 10000
    });

    const newOrder = res.data?.order;
    const orderName = newOrder?.name || `#${newOrder?.order_number}`;
    await db.addLog(
      'INFO',
      `🎉 Successfully created B2B Dropshipping Order ${orderName} on ${supplierStore.name} (Source Order #${sourceOrderName} from ${sellerStoreName})`,
      'order_creation',
      supplierStore.shopDomain
    );

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

// Synchronize / Deduct Inventory Quantities for Matching SKUs across connected stores (> 2 stores)
export async function syncInventoryAcrossStores(
  sourceShopDomain: string,
  sku: string,
  soldQuantity: number = 1,
  explicitNewQuantity?: number
): Promise<void> {
  const stores = await db.getAllStores();
  const cleanSource = cleanShopDomain(sourceShopDomain);

  // Determine updated available quantity from source store if explicit quantity provided
  let targetAvailable = explicitNewQuantity;

  if (targetAvailable === undefined) {
    const sourceStore = stores.find(s => cleanShopDomain(s.shopDomain) === cleanSource);
    if (sourceStore && sourceStore.accessToken) {
      const sourceVariant = await findVariantIdBySku(sourceShopDomain, sourceStore.accessToken, sku);
      if (sourceVariant && sourceVariant.availableQuantity !== undefined) {
        targetAvailable = sourceVariant.availableQuantity;
      }
    }
  }

  // Deduct inventory across all other connected stores
  for (const store of stores) {
    if (cleanShopDomain(store.shopDomain) === cleanSource || !store.isActive) continue;

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

        if (targetAvailable !== undefined) {
          // Set exact available quantity to match source store
          await axios.post(
            `https://${domain}/admin/api/2024-01/inventory_levels/set.json`,
            {
              location_id: locationId,
              inventory_item_id: variant.inventoryItemId,
              available: targetAvailable
            },
            {
              headers: { 'X-Shopify-Access-Token': store.accessToken },
              timeout: 8000
            }
          );
          await db.addLog(
            'INFO',
            `📉 Inventory Synced for SKU '${sku}' on ${store.name} -> Available set to: ${targetAvailable}`,
            'inventory_sync',
            store.shopDomain
          );
        } else {
          // Adjust inventory level by minus soldQuantity
          await axios.post(
            `https://${domain}/admin/api/2024-01/inventory_levels/adjust.json`,
            {
              location_id: locationId,
              inventory_item_id: variant.inventoryItemId,
              available_adjustment: -soldQuantity
            },
            {
              headers: { 'X-Shopify-Access-Token': store.accessToken },
              timeout: 8000
            }
          );
          await db.addLog(
            'INFO',
            `📉 Inventory Deducted (-${soldQuantity}) for SKU '${sku}' on connected store ${store.name}`,
            'inventory_sync',
            store.shopDomain
          );
        }
      } catch (err: any) {
        await db.addLog(
          'ERROR',
          `Failed to adjust inventory for SKU '${sku}' on ${store.name}: ${err.message}`,
          'inventory_sync',
          store.shopDomain
        );
      }
    }
  }
}

// Add Tag of Seller (e.g. Soldby-StoreAName) to Product across connected stores
export async function tagProductWithSellerOnStores(sku: string, sellerName: string): Promise<void> {
  if (!sku || !sellerName) return;
  const stores = await db.getAllStores();
  const sellerTag = `Soldby-${sellerName.replace(/\s+/g, '')}`;

  for (const store of stores) {
    if (!store.isActive || !store.accessToken) continue;

    try {
      const domain = cleanShopDomain(store.shopDomain);

      // Search product by SKU using GraphQL
      const query = `
        query findProductBySku($query: String!) {
          productVariants(first: 5, query: $query) {
            edges {
              node {
                product {
                  id
                  tags
                }
              }
            }
          }
        }
      `;

      const res = await axios.post(
        `https://${domain}/admin/api/2024-01/graphql.json`,
        { query, variables: { query: `sku:"${sku.replace(/"/g, '\\"')}"` } },
        {
          headers: { 'X-Shopify-Access-Token': store.accessToken },
          timeout: 8000
        }
      );

      const pEdges = res.data?.data?.productVariants?.edges || [];
      if (pEdges.length > 0 && pEdges[0].node?.product) {
        const productData = pEdges[0].node.product;
        const productIdRaw = productData.id;
        const cleanProductId = productIdRaw.split('/').pop();
        const existingTags = Array.isArray(productData.tags)
          ? productData.tags
          : (productData.tags ? String(productData.tags).split(',').map((t: string) => t.trim()) : []);

        const hasTag = existingTags.some(
          (t: string) => t.toLowerCase() === sellerTag.toLowerCase()
        );

        if (!hasTag) {
          const updatedTags = [...existingTags, sellerTag].join(', ');
          await axios.put(
            `https://${domain}/admin/api/2024-01/products/${cleanProductId}.json`,
            { product: { id: cleanProductId, tags: updatedTags } },
            {
              headers: { 'X-Shopify-Access-Token': store.accessToken },
              timeout: 8000
            }
          );
          await db.addLog(
            'INFO',
            `🏷️ Added tag '${sellerTag}' to product (SKU '${sku}') on ${store.name}`,
            'product_tag',
            store.shopDomain
          );
        }
      }
    } catch (err: any) {
      await db.addLog(
        'WARN',
        `Could not update product tag '${sellerTag}' for SKU '${sku}' on ${store.name}: ${err.message}`,
        'product_tag',
        store.shopDomain
      );
    }
  }
}


// Process Order Created Webhook Event
export async function processOrderCreatedWebhook(order: any, shopDomain: string, sourceStore: any) {
  const orderName = order.name || `OTS-${order.order_number || order.id}`;
  const orderIdStr = String(order.id || '');

  if (orderIdStr && orderIdStr !== 'N/A') {
    const alreadySynced = await db.hasOrderBeenSynced(shopDomain, orderIdStr);
    if (alreadySynced) {
      await db.addLog('INFO', `Order ${orderName} (${orderIdStr}) on ${shopDomain} already present in Order History. Skipping duplicate.`, 'orders/create', shopDomain);
      return;
    }
  }

  await db.addLog('INFO', `📦 Webhook Received: Order ${orderName} created on ${shopDomain}`, 'orders/create', shopDomain);

  // 🛑 Loop Protection Check
  const orderTags = Array.isArray(order.tags) ? order.tags.join(', ') : (order.tags || '');
  if (orderTags.toLowerCase().includes('automated dropship') || orderTags.toLowerCase().includes('soldby-')) {
    await db.addLog('INFO', `🛑 Loop Protection: Order ${orderName} has 'Automated Dropship' or 'Soldby-' tag. Skipping.`, 'orders/create', shopDomain);
    return;
  }

  const retailerStore = sourceStore || {
    shopDomain,
    name: shopDomain,
    supplierName: shopDomain.split('.')[0],
    ownerEmail: 'retailer@dropship-sync.com'
  };

  // Fetch complete order details using GraphQL API
  const parsedOrder = sourceStore?.accessToken
    ? await getOrderDetailsGraphQL(shopDomain, sourceStore.accessToken, String(order.id))
    : null;

  let lineItems: any[] = parsedOrder?.lineItems || [];

  if (lineItems.length === 0 && Array.isArray(order.line_items)) {
    lineItems = order.line_items.map((li: any) => ({
      id: String(li.id),
      title: li.title,
      sku: li.sku ? li.sku.trim() : '',
      quantity: li.quantity || 1,
      productId: String(li.product_id || ''),
      productTags: '',
      customSupplierMetafield: null,
      vendor: li.vendor || ''
    }));
  }

  // Maps for cross-store dropshipping and self-sales
  const supplierItemsMap: Map<string, { sku: string; quantity: number }[]> = new Map();
  const selfSaleItems: { sku: string; quantity: number }[] = [];
  const processedSkus: string[] = [];

  for (const item of lineItems) {
    if (!item.sku) {
      await db.addLog('WARN', `Item '${item.title}' in order ${orderName} has no SKU. Skipping.`, 'orders/create', shopDomain);
      continue;
    }

    processedSkus.push(`${item.sku} (x${item.quantity})`);

    let tags = item.productTags;
    let vendor = item.vendor;
    let metafield = item.customSupplierMetafield;

    // Fallback: If tags or metafield missing, fetch via REST API
    if ((!tags || !metafield) && sourceStore?.accessToken && item.productId) {
      const restProduct = await getProductDetailsREST(shopDomain, sourceStore.accessToken, item.productId);
      if (restProduct.tags) tags = restProduct.tags;
      if (restProduct.vendor) vendor = restProduct.vendor;
      if (restProduct.supplierMetafield) metafield = restProduct.supplierMetafield;
    }

    const supplierName = extractSupplierName(tags, metafield, vendor);
    await db.addLog(
      'INFO',
      `Line item SKU '${item.sku}' (Qty: ${item.quantity}) -> Resolved Ownership (custom.supplier / Tag): "${supplierName || 'None'}"`,
      'orders/create',
      shopDomain
    );

    let supplierStore = supplierName ? await db.getStoreBySupplierName(supplierName) : null;

    if (supplierStore) {
      if (supplierStore.shopDomain === shopDomain) {
        // Scenario 2: Store A sells its own product
        await db.addLog(
          'INFO',
          `✓ Store A (${shopDomain}) sells its own product (SKU '${item.sku}', Supplier: ${supplierStore.supplierName}). No dropshipping order required.`,
          'orders/create',
          shopDomain
        );
        selfSaleItems.push({ sku: item.sku, quantity: item.quantity });
      } else {
        // Scenario 1: Store B sells Store A's product
        if (!supplierItemsMap.has(supplierStore.shopDomain)) {
          supplierItemsMap.set(supplierStore.shopDomain, []);
        }
        supplierItemsMap.get(supplierStore.shopDomain)!.push({
          sku: item.sku,
          quantity: item.quantity
        });
      }
    } else {
      await db.addLog(
        'WARN',
        `No connected store matched supplier identifier "${supplierName || 'None'}" for SKU '${item.sku}'`,
        'orders/create',
        shopDomain
      );
    }
  }

  // Handle Scenario 2: Self-Sales Inventory Sync & Product Tagging
  if (selfSaleItems.length > 0) {
    for (const item of selfSaleItems) {
      // Deduct sold quantity from all other connected stores
      await syncInventoryAcrossStores(shopDomain, item.sku, item.quantity);

      // Add tag Soldby-SellerName to the product across connected stores
      await tagProductWithSellerOnStores(item.sku, retailerStore.supplierName || retailerStore.name);
    }

    const selfSkusStr = selfSaleItems.map(i => `${i.sku} (x${i.quantity})`).join(', ');

    await db.recordOrderSync({
      sourceShopDomain: shopDomain,
      targetShopDomain: shopDomain,
      sourceOrderId: String(order.id || 'N/A'),
      sourceOrderName: orderName,
      targetOrderId: String(order.id || 'N/A'),
      targetOrderName: orderName,
      status: 'SUCCESS',
      skus: selfSkusStr,
      error: `Self-sale by ${retailerStore.name}. Inventory deducted & product tagged Soldby-${retailerStore.supplierName || retailerStore.name} across connected stores.`
    });
  }

  // Handle Scenario 1: Cross-Store Dropshipping Orders
  for (const [targetShopDomain, items] of supplierItemsMap.entries()) {
    const targetStore = await db.getStoreByDomain(targetShopDomain);
    if (!targetStore) continue;

    await db.addLog(
      'INFO',
      `🚀 Creating B2B Dropshipping Order on ${targetStore.name} for ${items.length} item(s)...`,
      'orders/create',
      shopDomain
    );

    const result = await createSupplierFulfillmentOrder(targetStore, retailerStore, items, orderName);
    const skuListStr = items.map(i => `${i.sku} (x${i.quantity})`).join(', ');

    await db.recordOrderSync({
      sourceShopDomain: shopDomain,
      targetShopDomain,
      sourceOrderId: String(order.id),
      sourceOrderName: orderName,
      targetOrderId: result.orderId || null,
      targetOrderName: result.orderName || null,
      status: result.success ? 'SUCCESS' : 'FAILED',
      skus: skuListStr,
      error: result.error || null
    });

    // Auto-sync inventory & tag product across connected stores if total stores > 2
    for (const item of items) {
      await syncInventoryAcrossStores(targetStore.shopDomain, item.sku, item.quantity);
      await tagProductWithSellerOnStores(item.sku, retailerStore.supplierName || retailerStore.name);
    }
  }


  // If no items matched any rules, log as SKIPPED so every attempt appears in history
  if (selfSaleItems.length === 0 && supplierItemsMap.size === 0) {
    await db.recordOrderSync({
      sourceShopDomain: shopDomain,
      targetShopDomain: 'N/A',
      sourceOrderId: String(order.id || 'N/A'),
      sourceOrderName: orderName,
      targetOrderId: null,
      targetOrderName: null,
      status: 'SKIPPED',
      skus: processedSkus.join(', ') || 'No SKUs',
      error: 'No matching supplier identifier or SKUs configured for dropshipping sync.'
    });
  }
}


