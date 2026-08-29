// index.js - Automated Dropshipping (Hub Model / Option A) — Vercel Serverless Ready
require('dotenv').config();
const express = require('express');
const crypto = require('crypto');
const axios = require('axios');
const fs = require('fs');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 8000;

// --- IN-MEMORY LOG BUFFER (Safe for Vercel Serverless) ---
const MAX_LOGS = 150;
const inMemoryLogs = [];
const LOG_FILE = path.join('/tmp', 'activity.log');

function log(level, message) {
  const timestamp = new Date().toISOString();
  const logEntry = { timestamp, level, message };

  // Store in memory for API / UI
  inMemoryLogs.push(logEntry);
  if (inMemoryLogs.length > MAX_LOGS) {
    inMemoryLogs.shift();
  }

  // Always echo to console (Vercel runtime collects console logs)
  const formattedLine = `[${timestamp}] [${level}] ${message}`;
  if (level === 'ERROR') {
    console.error(formattedLine);
  } else {
    console.log(formattedLine);
  }

  // Best-effort write to log file (suppress read-only file system errors on serverless)
  try {
    fs.appendFile(LOG_FILE, formattedLine + '\n', (err) => {
      // Ignored intentionally on serverless read-only filesystems
    });
  } catch (err) {
    // Ignore filesystem write failures on Vercel
  }
}

// Middleware for HMAC & Static files
app.use(express.json({
  verify: (req, res, buf) => { req.rawBody = buf; }
}));

// Serve static assets from public/ folder
app.use(express.static(path.join(__dirname, 'public')));

// Log every incoming request hitting the server
app.use((req, res, next) => {
  if (!req.originalUrl.startsWith('/api/logs')) {
    log('INFO', `Incoming ${req.method} ${req.originalUrl} from ${req.ip || 'client'}`);
  }
  next();
});

// --- CONFIGURATION BUILDER ---
function getShopifyConfig() {
  return {
    STORE_A: { // RASHID
      key: 'STORE_A',
      name: "Rashid Store",
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
    STORE_B: { // Hamza
      key: 'STORE_B',
      name: "Hamza Store",
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

// --- FRONTEND DASHBOARD ROUTE ---
app.get('/', (req, res) => {
  const htmlPath = path.join(__dirname, 'public', 'index.html');
  if (fs.existsSync(htmlPath)) {
    res.sendFile(htmlPath);
  } else {
    res.status(200).send('<h1>Shopify Inventory Sync Hub</h1><p>Server running.</p>');
  }
});

// --- DIAGNOSTICS & STATUS API ---
app.get('/api/status', async (req, res) => {
  const config = getShopifyConfig();
  const report = {
    timestamp: new Date().toISOString(),
    overallStatus: 'OK',
    storeA: await testStoreConnection(config.STORE_A),
    storeB: await testStoreConnection(config.STORE_B)
  };

  if (report.storeA.status !== 'CONNECTED' || report.storeB.status !== 'CONNECTED') {
    report.overallStatus = 'DEGRADED';
  }
  if (report.storeA.status === 'ERROR' && report.storeB.status === 'ERROR') {
    report.overallStatus = 'ERROR';
  }

  res.json(report);
});

app.get('/api/logs', (req, res) => {
  res.json(inMemoryLogs);
});

async function testStoreConnection(store) {
  const missing = [];
  if (!store.url) missing.push(`${store.key}_URL`);
  if (!store.token) missing.push(`${store.key}_ACCESS_TOKEN`);
  if (!store.ownerEmail) missing.push(`${store.key}_OWNER_EMAIL`);

  if (missing.length > 0) {
    log('WARN', `${store.name} connection test: missing environment variables (${missing.join(', ')})`);
    return {
      name: store.name,
      url: store.url || null,
      ownerEmail: store.ownerEmail || null,
      status: 'CONFIG_MISSING',
      missingFields: missing,
      errorDetails: `Missing environment variable(s): ${missing.join(', ')}`
    };
  }

  // Format store URL safely
  let cleanUrl = store.url.replace(/^https?:\/\//, '').replace(/\/$/, '');

  try {
    const res = await axios.get(`https://${cleanUrl}/admin/api/2024-01/shop.json`, {
      headers: { 'X-Shopify-Access-Token': store.token },
      timeout: 8000
    });

    const shop = res.data?.shop || {};
    log('INFO', `Shopify API check SUCCESS for ${store.name} (${shop.name || cleanUrl})`);
    return {
      name: store.name,
      url: cleanUrl,
      ownerEmail: store.ownerEmail,
      status: 'CONNECTED',
      shopName: shop.name,
      myshopifyDomain: shop.myshopify_domain,
      domain: shop.domain,
      planName: shop.plan_name,
      currency: shop.currency
    };
  } catch (err) {
    let errorDetails = err.message;
    if (err.response) {
      if (err.response.status === 401) {
        errorDetails = `HTTP 401 Unauthorized: Invalid Shopify Access Token (${store.key}_ACCESS_TOKEN).`;
      } else if (err.response.status === 404) {
        errorDetails = `HTTP 404 Not Found: Check store URL (${store.key}_URL=${cleanUrl}).`;
      } else {
        errorDetails = `HTTP ${err.response.status} Error from Shopify: ${JSON.stringify(err.response.data)}`;
      }
    } else if (err.code === 'ENOTFOUND') {
      errorDetails = `DNS Lookup failed for store domain '${cleanUrl}'. Verify hostname.`;
    }

    log('ERROR', `Shopify API check FAILED for ${store.name}: ${errorDetails}`);
    return {
      name: store.name,
      url: cleanUrl,
      ownerEmail: store.ownerEmail,
      status: 'ERROR',
      errorDetails: errorDetails
    };
  }
}

// --- WEBHOOKS ---

// 1. Order Created on RASHID'S STORE
app.post('/webhooks/store-a/orders/create', async (req, res) => {
  const config = getShopifyConfig();
  try {
    const verified = verifyWebhook(req, config.STORE_A.webhookSecret);
    log('INFO', `Webhook hit: store-a/orders/create | order=${req.body?.name || 'unknown'} | verified=${verified}`);

    if (!verified && config.STORE_A.webhookSecret) {
      log('ERROR', `store-a webhook failed HMAC verification for order ${req.body?.name || 'unknown'}`);
      return res.status(401).send('Unauthorized');
    }

    await processDropship(req.body, config.STORE_A, config.STORE_B, 'Supplier: Hamza');
    res.status(200).send('Processed');
  } catch (e) {
    log('ERROR', `store-a webhook handler error: ${e.message}`);
    res.status(500).send('Error');
  }
});

// 2. Order Created on Hamza'S STORE
app.post('/webhooks/store-b/orders/create', async (req, res) => {
  const config = getShopifyConfig();
  try {
    const verified = verifyWebhook(req, config.STORE_B.webhookSecret);
    log('INFO', `Webhook hit: store-b/orders/create | order=${req.body?.name || 'unknown'} | verified=${verified}`);

    if (!verified && config.STORE_B.webhookSecret) {
      log('ERROR', `store-b webhook failed HMAC verification for order ${req.body?.name || 'unknown'}`);
      return res.status(401).send('Unauthorized');
    }

    await processDropship(req.body, config.STORE_B, config.STORE_A, 'Supplier: Rashid');
    res.status(200).send('Processed');
  } catch (e) {
    log('ERROR', `store-b webhook handler error: ${e.message}`);
    res.status(500).send('Error');
  }
});

// --- LOGIC ---

async function processDropship(order, sourceStore, targetStore, targetSupplierTag) {
  log('INFO', `Processing Order ${order.name} from ${sourceStore.name}`);

  // 🛑 LOOP PROTECTION
  if (order.email === targetStore.ownerEmail) {
    log('INFO', `Loop protection active for order ${order.name}. Ignoring B2B order.`);
    return;
  }

  const itemsToDropship = [];

  for (const item of (order.line_items || [])) {
    if (!item.sku) continue;

    const tags = await getProductTags(sourceStore, item.product_id);
    if (tags.includes(targetSupplierTag)) {
      log('INFO', `Found dropship item: SKU=${item.sku} qty=${item.quantity} (order ${order.name})`);
      itemsToDropship.push({
        sku: item.sku,
        quantity: item.quantity
      });
    }
  }

  if (itemsToDropship.length > 0) {
    await createOrderOnSupplierStore(targetStore, sourceStore, itemsToDropship);
  } else {
    log('INFO', `No dropship items found in order ${order.name}. Nothing to do.`);
  }
}

async function getProductTags(store, productId) {
  try {
    const cleanUrl = store.url.replace(/^https?:\/\//, '').replace(/\/$/, '');
    const res = await axios.get(`https://${cleanUrl}/admin/api/2024-01/products/${productId}.json`, {
      headers: { 'X-Shopify-Access-Token': store.token },
      timeout: 8000
    });
    return res.data.product?.tags || '';
  } catch (e) {
    log('ERROR', `Error fetching product ${productId} from ${store.name}: ${e.message}`);
    return '';
  }
}

async function createOrderOnSupplierStore(supplierStore, retailerStore, items) {
  log('INFO', `Creating order on ${supplierStore.name} for ${items.length} item(s)...`);

  const line_items = [];
  for (const item of items) {
    const variantId = await findVariantIdBySku(supplierStore, item.sku);
    if (variantId) {
      line_items.push({
        variant_id: variantId,
        quantity: item.quantity
      });
    } else {
      log('ERROR', `SKU ${item.sku} not found on ${supplierStore.name}`);
    }
  }

  if (line_items.length === 0) {
    log('ERROR', `No matching variants found on ${supplierStore.name}. Order not created.`);
    return;
  }

  const orderPayload = {
    order: {
      line_items: line_items,
      email: retailerStore.ownerEmail, 
      shipping_address: retailerStore.address,
      billing_address: retailerStore.address,
      tags: "Automated Dropship",
      financial_status: "pending",
      note: `Auto-generated order for items sold on ${retailerStore.name}`
    }
  };

  try {
    const cleanUrl = supplierStore.url.replace(/^https?:\/\//, '').replace(/\/$/, '');
    const res = await axios.post(`https://${cleanUrl}/admin/api/2024-01/orders.json`, orderPayload, {
      headers: { 'X-Shopify-Access-Token': supplierStore.token },
      timeout: 10000
    });
    log('INFO', `Successfully created Order #${res.data.order.order_number} on ${supplierStore.name}`);
  } catch (e) {
    const detail = e.response ? JSON.stringify(e.response.data) : e.message;
    log('ERROR', `Failed to create order on ${supplierStore.name}: ${detail}`);
  }
}

async function findVariantIdBySku(store, sku) {
  const query = `
    {
      products(first: 1, query: "sku:${sku}") {
        edges {
          node {
            variants(first: 1) {
              edges {
                node {
                  id
                }
              }
            }
          }
        }
      }
    }
  `;
  try {
    const cleanUrl = store.url.replace(/^https?:\/\//, '').replace(/\/$/, '');
    const res = await axios.post(`https://${cleanUrl}/admin/api/2024-01/graphql.json`, { query }, {
      headers: { 'X-Shopify-Access-Token': store.token },
      timeout: 8000
    });
    const variantId = res.data.data?.products?.edges[0]?.node?.variants?.edges[0]?.node?.id;
    return variantId ? variantId.split('/').pop() : null;
  } catch (e) {
    log('ERROR', `GraphQL variant lookup failed for SKU ${sku} on ${store.name}: ${e.message}`);
    return null;
  }
}

// Start server locally if not invoked as a Vercel serverless module
if (require.main === module) {
  app.listen(PORT, () => log('INFO', `Server running on port ${PORT}`));
}

// Export Express app for Vercel Serverless environment
module.exports = app;