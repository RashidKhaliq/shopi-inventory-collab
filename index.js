// index.js - Automated Dropshipping (Hub Model / Option A) — Vercel Ready & Diagnostic Enhanced
require('dotenv').config();
const express = require('express');
const crypto = require('crypto');
const axios = require('axios');
const fs = require('fs');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 8000;

// --- IN-MEMORY LOG BUFFER ---
const MAX_LOGS = 200;
const inMemoryLogs = [];
const LOG_FILE = path.join('/tmp', 'activity.log');

function log(level, message) {
  const timestamp = new Date().toISOString();
  const logEntry = { timestamp, level, message };

  inMemoryLogs.push(logEntry);
  if (inMemoryLogs.length > MAX_LOGS) {
    inMemoryLogs.shift();
  }

  const formattedLine = `[${timestamp}] [${level}] ${message}`;
  if (level === 'ERROR') {
    console.error(formattedLine);
  } else {
    console.log(formattedLine);
  }

  try {
    fs.appendFile(LOG_FILE, formattedLine + '\n', () => {});
  } catch (err) {}
}

// Middleware
app.use(express.json({
  verify: (req, res, buf) => { req.rawBody = buf; }
}));

app.use(express.static(path.join(__dirname, 'public')));

app.use((req, res, next) => {
  if (!req.originalUrl.startsWith('/api/logs') && !req.originalUrl.startsWith('/api/status')) {
    log('INFO', `Incoming ${req.method} ${req.originalUrl} from ${req.ip || 'client'}`);
  }
  next();
});

// --- CONFIGURATION ---
function getShopifyConfig() {
  return {
    STORE_A: {
      key: 'STORE_A',
      name: "Rashid Store (Store A)",
      url: process.env.STORE_A_URL,
      token: process.env.STORE_A_ACCESS_TOKEN,
      ownerEmail: process.env.STORE_A_OWNER_EMAIL,
      webhookSecret: process.env.STORE_A_WEBHOOK_SECRET,
      address: { 
        first_name: "Rashid", 
        last_name: "Khaliq",
        address1: "Township", 
        city: "Lahore", 
        country: "PK", 
        zip: "54000" 
      }
    },
    STORE_B: {
      key: 'STORE_B',
      name: "Hamza Store (Store B)",
      url: process.env.STORE_B_URL,
      token: process.env.STORE_B_ACCESS_TOKEN,
      ownerEmail: process.env.STORE_B_OWNER_EMAIL,
      webhookSecret: process.env.STORE_B_WEBHOOK_SECRET,
      address: { 
        first_name: "Hamza", 
        last_name: "Owner",
        address1: "Wapda Town", 
        city: "Lahore", 
        country: "PK", 
        zip: "54000" 
      }
    }
  };
}

const verifyWebhook = (req, secret) => {
  if (!req.rawBody || !secret) return false;
  const hmac = req.get('X-Shopify-Hmac-Sha256');
  const generatedHash = crypto.createHmac('sha256', secret).update(req.rawBody, 'utf8').digest('base64');
  return hmac === generatedHash;
};

// --- Helper: Clean Domain ---
function cleanDomain(url) {
  if (!url) return '';
  return url.replace(/^https?:\/\//i, '').replace(/\/$/, '').trim();
}

// --- Helper: Case & Whitespace Insensitive Tag Match ---
function hasSupplierTag(tagsString, targetSupplierTag) {
  if (!tagsString) return false;
  // E.g. targetSupplierTag = "Supplier: Rashid" -> clean: "supplier:rashid"
  const targetClean = targetSupplierTag.toLowerCase().replace(/\s+/g, '');
  
  // Split tags by comma
  const tagsList = tagsString.split(',').map(t => t.trim().toLowerCase());
  return tagsList.some(tag => {
    const cleanTag = tag.replace(/\s+/g, '');
    return cleanTag === targetClean || cleanTag === targetSupplierTag.toLowerCase();
  });
}

// --- FRONTEND ROUTE ---
app.get('/', (req, res) => {
  const htmlPath = path.join(__dirname, 'public', 'index.html');
  if (fs.existsSync(htmlPath)) {
    res.sendFile(htmlPath);
  } else {
    res.status(200).send('<h1>Shopify Inventory Sync Hub</h1>');
  }
});

// --- DETAILED ENVIRONMENT VARIABLE DIAGNOSTICS API ---
app.get('/api/verify-env', async (req, res) => {
  const config = getShopifyConfig();
  
  const envCheck = {
    STORE_A_URL: checkEnvVar('STORE_A_URL', config.STORE_A.url),
    STORE_A_ACCESS_TOKEN: checkEnvVar('STORE_A_ACCESS_TOKEN', config.STORE_A.token, true),
    STORE_A_OWNER_EMAIL: checkEnvVar('STORE_A_OWNER_EMAIL', config.STORE_A.ownerEmail),
    STORE_A_WEBHOOK_SECRET: checkEnvVar('STORE_A_WEBHOOK_SECRET', config.STORE_A.webhookSecret, true, false),

    STORE_B_URL: checkEnvVar('STORE_B_URL', config.STORE_B.url),
    STORE_B_ACCESS_TOKEN: checkEnvVar('STORE_B_ACCESS_TOKEN', config.STORE_B.token, true),
    STORE_B_OWNER_EMAIL: checkEnvVar('STORE_B_OWNER_EMAIL', config.STORE_B.ownerEmail),
    STORE_B_WEBHOOK_SECRET: checkEnvVar('STORE_B_WEBHOOK_SECRET', config.STORE_B.webhookSecret, true, false)
  };

  // Test live Shopify API connections
  const storeATest = await testStoreConnectionDetailed(config.STORE_A);
  const storeBTest = await testStoreConnectionDetailed(config.STORE_B);

  const allVarsPresent = Object.values(envCheck).every(v => !v.required || v.status === 'OK');
  const allApiConnected = storeATest.status === 'CONNECTED' && storeBTest.status === 'CONNECTED';

  res.json({
    timestamp: new Date().toISOString(),
    overallStatus: (allVarsPresent && allApiConnected) ? 'ALL_SYSTEMS_GO' : 'CONFIGURATION_OR_AUTH_ISSUES',
    envVariables: envCheck,
    storeA: storeATest,
    storeB: storeBTest
  });
});

function checkEnvVar(key, value, isSecret = false, required = true) {
  if (!value || value.trim() === '') {
    return {
      key,
      status: required ? 'MISSING' : 'OPTIONAL_NOT_SET',
      required,
      displayValue: 'Not set'
    };
  }
  let displayValue = value;
  if (isSecret) {
    displayValue = value.length > 8 ? `${value.substring(0, 4)}...${value.substring(value.length - 4)}` : '****';
  }
  return {
    key,
    status: 'OK',
    required,
    displayValue
  };
}

// --- BASIC STATUS API ---
app.get('/api/status', async (req, res) => {
  const config = getShopifyConfig();
  const report = {
    timestamp: new Date().toISOString(),
    overallStatus: 'OK',
    storeA: await testStoreConnectionDetailed(config.STORE_A),
    storeB: await testStoreConnectionDetailed(config.STORE_B)
  };

  if (report.storeA.status !== 'CONNECTED' || report.storeB.status !== 'CONNECTED') {
    report.overallStatus = 'DEGRADED';
  }
  res.json(report);
});

app.get('/api/logs', (req, res) => {
  res.json(inMemoryLogs);
});

async function testStoreConnectionDetailed(store) {
  const missing = [];
  if (!store.url) missing.push(`${store.key}_URL`);
  if (!store.token) missing.push(`${store.key}_ACCESS_TOKEN`);
  if (!store.ownerEmail) missing.push(`${store.key}_OWNER_EMAIL`);

  if (missing.length > 0) {
    return {
      name: store.name,
      url: store.url || null,
      ownerEmail: store.ownerEmail || null,
      status: 'CONFIG_MISSING',
      missingFields: missing,
      errorDetails: `Missing required env variable(s): ${missing.join(', ')}`
    };
  }

  const domain = cleanDomain(store.url);

  try {
    // 1. Check shop info
    const shopRes = await axios.get(`https://${domain}/admin/api/2024-01/shop.json`, {
      headers: { 'X-Shopify-Access-Token': store.token },
      timeout: 8000
    });

    const shop = shopRes.data?.shop || {};

    // 2. Check read_products permission
    let canReadProducts = false;
    try {
      await axios.get(`https://${domain}/admin/api/2024-01/products.json?limit=1`, {
        headers: { 'X-Shopify-Access-Token': store.token },
        timeout: 5000
      });
      canReadProducts = true;
    } catch (e) {
      log('WARN', `Store ${store.name} token cannot read products: ${e.message}`);
    }

    log('INFO', `Shopify API check SUCCESS for ${store.name} (${shop.name || domain})`);
    return {
      name: store.name,
      url: domain,
      ownerEmail: store.ownerEmail,
      status: 'CONNECTED',
      shopName: shop.name,
      myshopifyDomain: shop.myshopify_domain,
      domain: shop.domain,
      planName: shop.plan_name,
      currency: shop.currency,
      permissions: {
        readShop: true,
        readProducts: canReadProducts
      }
    };
  } catch (err) {
    let errorDetails = err.message;
    if (err.response) {
      if (err.response.status === 401) {
        errorDetails = `HTTP 401 Unauthorized: Invalid Shopify Access Token (${store.key}_ACCESS_TOKEN).`;
      } else if (err.response.status === 404) {
        errorDetails = `HTTP 404 Not Found: Check store URL domain (${store.key}_URL=${domain}).`;
      } else {
        errorDetails = `HTTP ${err.response.status} Error from Shopify: ${JSON.stringify(err.response.data)}`;
      }
    } else if (err.code === 'ENOTFOUND') {
      errorDetails = `DNS Lookup failed for store domain '${domain}'. Verify URL.`;
    }

    log('ERROR', `Shopify API check FAILED for ${store.name}: ${errorDetails}`);
    return {
      name: store.name,
      url: domain,
      ownerEmail: store.ownerEmail,
      status: 'ERROR',
      errorDetails: errorDetails
    };
  }
}

// --- MANUAL TEST SIMULATOR API ---
app.post('/api/test-sync', async (req, res) => {
  const { direction, sku, orderName } = req.body || {};
  const config = getShopifyConfig();

  let sourceStore, targetStore, supplierTag;

  if (direction === 'B_TO_A') {
    sourceStore = config.STORE_B;
    targetStore = config.STORE_A;
    supplierTag = 'Supplier: Rashid';
  } else {
    sourceStore = config.STORE_A;
    targetStore = config.STORE_B;
    supplierTag = 'Supplier: Hamza';
  }

  log('INFO', `🧪 TEST SIMULATION: Testing order sync from ${sourceStore.name} to ${targetStore.name} (SKU: ${sku || 'TEST-SKU'})`);

  const mockOrder = {
    name: orderName || '#TEST-9999',
    email: 'customer@example.com',
    line_items: [
      {
        product_id: 123456789,
        sku: sku || 'TEST-SKU',
        quantity: 1
      }
    ]
  };

  const results = [];
  results.push(`Starting simulation: Order ${mockOrder.name} on ${sourceStore.name}`);

  // Test target variant lookup on supplier store
  const variantId = await findVariantIdBySku(targetStore, mockOrder.line_items[0].sku);
  if (variantId) {
    results.push(`✓ Found SKU '${mockOrder.line_items[0].sku}' on ${targetStore.name} (Variant ID: ${variantId})`);
  } else {
    results.push(`✕ Could not find SKU '${mockOrder.line_items[0].sku}' on ${targetStore.name}. Please ensure SKU exists in ${targetStore.name}.`);
  }

  res.json({
    success: !!variantId,
    direction,
    sku: mockOrder.line_items[0].sku,
    variantIdFound: variantId,
    logTrace: results
  });
});

// --- WEBHOOKS ---

// 1. Order Created on RASHID'S STORE (Store A)
app.post('/webhooks/store-a/orders/create', async (req, res) => {
  const config = getShopifyConfig();
  try {
    const secret = config.STORE_A.webhookSecret;
    let verified = true;

    if (secret) {
      verified = verifyWebhook(req, secret);
      if (!verified) {
        log('ERROR', `Store A webhook failed HMAC verification for order ${req.body?.name || 'unknown'}. Check STORE_A_WEBHOOK_SECRET.`);
        return res.status(401).send('Unauthorized HMAC signature');
      }
    } else {
      log('WARN', `Store A webhook received without STORE_A_WEBHOOK_SECRET set (bypassing HMAC verification).`);
    }

    log('INFO', `📦 Webhook Hit: Store A Order Created (${req.body?.name || 'unknown'}, ID: ${req.body?.id})`);
    await processDropship(req.body, config.STORE_A, config.STORE_B, 'Supplier: Hamza');
    res.status(200).send('Processed');
  } catch (e) {
    log('ERROR', `Store A webhook handler error: ${e.message}`);
    res.status(500).send('Error');
  }
});

// 2. Order Created on HAMZA'S STORE (Store B)
app.post('/webhooks/store-b/orders/create', async (req, res) => {
  const config = getShopifyConfig();
  try {
    const secret = config.STORE_B.webhookSecret;
    let verified = true;

    if (secret) {
      verified = verifyWebhook(req, secret);
      if (!verified) {
        log('ERROR', `Store B webhook failed HMAC verification for order ${req.body?.name || 'unknown'}. Check STORE_B_WEBHOOK_SECRET.`);
        return res.status(401).send('Unauthorized HMAC signature');
      }
    } else {
      log('WARN', `Store B webhook received without STORE_B_WEBHOOK_SECRET set (bypassing HMAC verification).`);
    }

    log('INFO', `📦 Webhook Hit: Store B Order Created (${req.body?.name || 'unknown'}, ID: ${req.body?.id})`);
    await processDropship(req.body, config.STORE_B, config.STORE_A, 'Supplier: Rashid');
    res.status(200).send('Processed');
  } catch (e) {
    log('ERROR', `Store B webhook handler error: ${e.message}`);
    res.status(500).send('Error');
  }
});

// --- CORE DROPSHIP ENGINE ---

async function processDropship(order, sourceStore, targetStore, targetSupplierTag) {
  const orderName = order?.name || `ID_${order?.id}`;
  log('INFO', `🔍 Evaluating Order ${orderName} from ${sourceStore.name} for dropship items...`);

  // 🛑 LOOP PROTECTION: Check for automated dropship tag
  const orderTags = (order?.tags || '').toLowerCase();
  if (orderTags.includes('automated dropship') || orderTags.includes('soldby-')) {
    log('INFO', `🛑 Loop Protection: Order ${orderName} has 'Automated Dropship' or 'Soldby-' tag. Skipping to prevent loop.`);
    return;
  }

  const lineItems = order?.line_items || [];
  log('INFO', `Order ${orderName} contains ${lineItems.length} line item(s).`);

  const itemsToDropship = [];
  const processedSkus = [];

  for (const item of lineItems) {
    const sku = item.sku ? item.sku.trim() : '';
    if (!sku) {
      log('WARN', `Line item '${item.title}' (ID ${item.id}) in order ${orderName} has NO SKU. Skipping.`);
      continue;
    }

    processedSkus.push(`${sku} (x${item.quantity || 1})`);
    log('INFO', `Inspecting line item SKU: '${sku}' (Product ID: ${item.product_id})...`);

    // Fetch tags & metafields from source store to see if this product belongs to supplier
    const productInfo = await getProductDetails(sourceStore, item.product_id);
    const tagsString = productInfo.tags;
    const metafieldVal = productInfo.metafield;
    log('INFO', `Product ${item.product_id} tags: "${tagsString}", custom.supplier metafield: "${metafieldVal || 'None'}"`);

    const isMatch = checkOwnershipMatch(metafieldVal, tagsString, targetSupplierTag);
    if (isMatch) {
      log('INFO', `✓ SUPPLIER MATCH: Item SKU '${sku}' belongs to target supplier tag '${targetSupplierTag}'!`);
      itemsToDropship.push({
        sku: sku,
        quantity: item.quantity || 1,
        title: item.title
      });
    } else {
      log('INFO', `ℹ️ Item SKU '${sku}' does not match target supplier tag '${targetSupplierTag}'.`);
    }
  }

  if (itemsToDropship.length > 0) {
    log('INFO', `🚀 Found ${itemsToDropship.length} item(s) to dropship to ${targetStore.name}. Creating B2B order...`);
    await createOrderOnSupplierStore(targetStore, sourceStore, itemsToDropship, orderName, processedSkus);
  } else {
    log('INFO', `ℹ️ No dropship items matching '${targetSupplierTag}' found in order ${orderName}. Nothing to sync.`);
  }
}

function checkOwnershipMatch(metafield, tags, targetSupplierTag) {
  if (metafield && typeof metafield === 'string' && metafield.trim() !== '') {
    const cleanMeta = metafield.trim().toLowerCase();
    const cleanTarget = targetSupplierTag.replace(/^(?:Supplier|supplier)[:_\s]+/i, '').trim().toLowerCase();
    if (cleanMeta === cleanTarget || targetSupplierTag.toLowerCase().includes(cleanMeta)) return true;
  }
  return hasSupplierTag(tags, targetSupplierTag);
}

async function getProductDetails(store, productId) {
  if (!productId) return { tags: '', metafield: null };
  const domain = cleanDomain(store.url);

  let tags = '';
  let metafield = null;

  try {
    const res = await axios.get(`https://${domain}/admin/api/2024-01/products/${productId}.json`, {
      headers: { 'X-Shopify-Access-Token': store.token },
      timeout: 8000
    });
    tags = res.data?.product?.tags || '';
  } catch (e) {}

  try {
    const metaRes = await axios.get(`https://${domain}/admin/api/2024-01/products/${productId}/metafields.json`, {
      headers: { 'X-Shopify-Access-Token': store.token },
      timeout: 8000
    });
    const metafields = metaRes.data?.metafields || [];
    const found = metafields.find(m => (m.namespace === 'custom' && m.key === 'supplier') || m.key === 'supplier');
    if (found && found.value) metafield = String(found.value).trim();
  } catch (e) {}

  return { tags, metafield };
}

async function createOrderOnSupplierStore(supplierStore, retailerStore, items, sourceOrderName, processedSkus = []) {
  log('INFO', `🔄 Creating fulfillment order on ${supplierStore.name} for ${items.length} item(s)...`);

  const line_items = [];
  for (const item of items) {
    const variantId = await findVariantIdBySku(supplierStore, item.sku);
    if (variantId) {
      line_items.push({
        variant_id: variantId,
        quantity: item.quantity
      });
      log('INFO', `✓ Mapped SKU '${item.sku}' -> Supplier Variant ID: ${variantId}`);
    } else {
      log('ERROR', `❌ SKU '${item.sku}' NOT FOUND on ${supplierStore.name}. Cannot include in supplier order.`);
    }
  }

  if (line_items.length === 0) {
    log('ERROR', `❌ None of the dropship SKUs could be matched on ${supplierStore.name}. Order creation aborted.`);
    return;
  }

  const sellerEmail = retailerStore.ownerEmail && retailerStore.ownerEmail.includes('@')
    ? retailerStore.ownerEmail
    : 'seller@dropship-sync.com';

  const sellerStoreName = retailerStore.name || `Store ${retailerStore.key}`;

  const orderPayload = {
    order: {
      line_items: line_items,
      customer: {
        first_name: sellerStoreName,
        last_name: "(Seller Store)",
        email: sellerEmail
      },
      email: sellerEmail,
      shipping_address: retailerStore.address,
      billing_address: retailerStore.address,
      source_name: "Dropshipping",
      tags: `Automated Dropship, Dropshipping, Soldby-${retailerStore.key || sellerStoreName}`,
      financial_status: "pending",
      inventory_behaviour: "decrement_obeying_policy",
      note: `Dropshipping order placed by ${sellerStoreName} (${retailerStore.url}) for original order #${sourceOrderName}.`
    }
  };

  try {
    const domain = cleanDomain(supplierStore.url);
    const res = await axios.post(`https://${domain}/admin/api/2024-01/orders.json`, orderPayload, {
      headers: { 'X-Shopify-Access-Token': supplierStore.token },
      timeout: 10000
    });

    const newOrderNumber = res.data?.order?.order_number || res.data?.order?.id;
    log('INFO', `🎉 SUCCESS! Created Order #${newOrderNumber} on ${supplierStore.name} (Source Order: ${sourceOrderName})`);
  } catch (e) {
    const detail = e.response ? JSON.stringify(e.response.data) : e.message;
    log('ERROR', `❌ Failed to create order on ${supplierStore.name}: ${detail}`);
  }
}

async function findVariantIdBySku(store, sku) {
  const cleanSku = sku.trim();
  const domain = cleanDomain(store.url);

  // 1. Try GraphQL Query first
  const query = `
    {
      products(first: 10, query: "sku:${cleanSku}") {
        edges {
          node {
            variants(first: 25) {
              edges {
                node {
                  id
                  sku
                }
              }
            }
          }
        }
      }
    }
  `;

  try {
    const res = await axios.post(`https://${domain}/admin/api/2024-01/graphql.json`, { query }, {
      headers: { 'X-Shopify-Access-Token': store.token },
      timeout: 8000
    });

    const products = res.data?.data?.products?.edges || [];
    for (const pEdge of products) {
      const variants = pEdge.node?.variants?.edges || [];
      for (const vEdge of variants) {
        if (vEdge.node?.sku && vEdge.node.sku.trim().toLowerCase() === cleanSku.toLowerCase()) {
          const gid = vEdge.node.id;
          return gid ? gid.split('/').pop() : null;
        }
      }
    }
  } catch (e) {
    log('WARN', `GraphQL variant lookup failed for SKU '${cleanSku}' on ${store.name}: ${e.message}`);
  }

  // 2. Fallback to REST API variant lookup
  try {
    const restRes = await axios.get(`https://${domain}/admin/api/2024-01/variants.json?sku=${encodeURIComponent(cleanSku)}`, {
      headers: { 'X-Shopify-Access-Token': store.token },
      timeout: 8000
    });

    const variants = restRes.data?.variants || [];
    const match = variants.find(v => v.sku && v.sku.trim().toLowerCase() === cleanSku.toLowerCase());
    if (match) {
      return match.id;
    }
  } catch (e) {
    log('WARN', `REST variant lookup fallback failed for SKU '${cleanSku}' on ${store.name}: ${e.message}`);
  }

  return null;
}

// Start local server if directly executed
if (require.main === module) {
  app.listen(PORT, () => log('INFO', `Server running on port ${PORT}`));
}

module.exports = app;