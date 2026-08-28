// index.js - Automated Dropshipping (Hub Model / Option A)
require('dotenv').config();
const express = require('express');
const crypto = require('crypto');
const axios = require('axios');
const fs = require('fs');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 8000;

// --- LOGGING ---
// Writes every activity (webhook hits, verification results, order processing,
// errors) to activity.log in the same directory as this script, and also
// echoes to the console.
const LOG_FILE = path.join(__dirname, 'activity.log');

function log(level, message) {
  const timestamp = new Date().toISOString();
  const line = `[${timestamp}] [${level}] ${message}`;

  // Always echo to console
  if (level === 'ERROR') {
    console.error(line);
  } else {
    console.log(line);
  }

  // Append to log file (fire-and-forget, but catch errors so logging
  // failures never crash the app)
  fs.appendFile(LOG_FILE, line + '\n', (err) => {
    if (err) console.error(`Failed to write to log file: ${err.message}`);
  });
}

// Middleware for HMAC
app.use(express.json({
  verify: (req, res, buf) => { req.rawBody = buf; }
}));

// Log every incoming request hitting the server (webhook or otherwise)
app.use((req, res, next) => {
  log('INFO', `Incoming ${req.method} ${req.originalUrl} from ${req.ip}`);
  next();
});

// --- CONFIGURATION ---
// Addresses are hardcoded here for simplicity, but you can move them to .env if you prefer JSON parsing.
const SHOPIFY_CONFIG = {
  STORE_A: { // RASHID
    name: "Rashid Store",
    url: process.env.STORE_A_URL,
    token: process.env.STORE_A_ACCESS_TOKEN,
    ownerEmail: process.env.STORE_A_OWNER_EMAIL, // rashidkhaliq88@gmail.com
    // The address Rashid ships TO (Hamza's address) if Hamza orders from him
    // Since this is Option A: The partner receives the goods.
    // NOTE: When Rashid orders from Hamza, it ships to Rashid. When Hamza orders from Rashid, it ships to Hamza.
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
    name: "Hamza Store",
    url: process.env.STORE_B_URL,
    token: process.env.STORE_B_ACCESS_TOKEN,
    ownerEmail: process.env.STORE_B_OWNER_EMAIL, // Hamzatvc@gmail.com
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

// Warn on startup if config looks incomplete (e.g. .env not loaded)
for (const key of ['STORE_A', 'STORE_B']) {
  const store = SHOPIFY_CONFIG[key];
  if (!store.url || !store.token || !store.ownerEmail) {
    log('ERROR', `${key} is missing config (url/token/ownerEmail). Check .env is present and loaded.`);
  }
}

const verifyWebhook = (req, secret) => {
  if (!req.rawBody || !secret) return false;
  const hmac = req.get('X-Shopify-Hmac-Sha256');
  const generatedHash = crypto.createHmac('sha256', secret).update(req.rawBody, 'utf8').digest('base64');
  return hmac === generatedHash;
};

// --- WEBHOOKS ---

// 1. Order Created on RASHID'S STORE
// Detects if Rashid sold Hamza's items. If so, creates order on Hamza's store.
app.post('/webhooks/store-a/orders/create', async (req, res) => {
  try {
    const verified = verifyWebhook(req, process.env.STORE_A_WEBHOOK_SECRET);
    log('INFO', `Webhook hit: store-a/orders/create | order=${req.body?.name || 'unknown'} | verified=${verified}`);

    if (!verified) {
      log('ERROR', `store-a webhook failed HMAC verification for order ${req.body?.name || 'unknown'}`);
      return res.status(401).send('Unauthorized');
    }

    // We check if any item sold on Rashid's store has the tag "Supplier: Hamza"
    await processDropship(req.body, SHOPIFY_CONFIG.STORE_A, SHOPIFY_CONFIG.STORE_B, 'Supplier: Hamza');

    res.status(200).send('Processed');
  } catch (e) {
    log('ERROR', `store-a webhook handler error: ${e.message}`);
    res.status(500).send('Error');
  }
});

// 2. Order Created on Hamza'S STORE
// Detects if Hamza sold Rashid's items. If so, creates order on Rashid's store.
app.post('/webhooks/store-b/orders/create', async (req, res) => {
  try {
    const verified = verifyWebhook(req, process.env.STORE_B_WEBHOOK_SECRET);
    log('INFO', `Webhook hit: store-b/orders/create | order=${req.body?.name || 'unknown'} | verified=${verified}`);

    if (!verified) {
      log('ERROR', `store-b webhook failed HMAC verification for order ${req.body?.name || 'unknown'}`);
      return res.status(401).send('Unauthorized');
    }

    // We check if any item sold on Hamza's store has the tag "Supplier: Rashid"
    await processDropship(req.body, SHOPIFY_CONFIG.STORE_B, SHOPIFY_CONFIG.STORE_A, 'Supplier: Rashid');

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
  // If the order email matches the Target Store Owner, it means the Target Store Owner created this order.
  // We should NOT dropship it back to them.
  if (order.email === targetStore.ownerEmail) {
    log('INFO', `Loop protection active for order ${order.name}. Ignoring B2B order.`);
    return;
  }

  const itemsToDropship = [];

  // Check every item in the order
  for (const item of order.line_items) {
    if (!item.sku) continue;

    // Fetch tags from the SOURCE store to see if it's a dropship item
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
    const res = await axios.get(`https://${store.url}/admin/api/2024-01/products/${productId}.json`, {
      headers: { 'X-Shopify-Access-Token': store.token }
    });
    return res.data.product.tags || '';
  } catch (e) {
    log('ERROR', `Error fetching product ${productId} from ${store.name}: ${e.message}`);
    return '';
  }
}

async function createOrderOnSupplierStore(supplierStore, retailerStore, items) {
  log('INFO', `Creating order on ${supplierStore.name} for ${items.length} item(s)...`);

  // 1. Map SKUs to Variant IDs on the Supplier Store
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

  // 2. Construct Order
  // Customer is the Retailer (Hamza or Rashid). 
  // Shipping Address is the Retailer's Address (Option A).
  const orderPayload = {
    order: {
      line_items: line_items,
      email: retailerStore.ownerEmail, 
      shipping_address: retailerStore.address,
      billing_address: retailerStore.address,
      tags: "Automated Dropship",
      financial_status: "pending", // Created as Pending so you can review before paying/fulfilling
      note: `Auto-generated order for items sold on ${retailerStore.name}`
    }
  };

  try {
    const res = await axios.post(`https://${supplierStore.url}/admin/api/2024-01/orders.json`, orderPayload, {
      headers: { 'X-Shopify-Access-Token': supplierStore.token }
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
    const res = await axios.post(`https://${store.url}/admin/api/2024-01/graphql.json`, { query }, {
      headers: { 'X-Shopify-Access-Token': store.token }
    });
    const variantId = res.data.data.products.edges[0]?.node.variants.edges[0]?.node.id;
    // Convert gid://shopify/ProductVariant/12345 to 12345 if necessary, though REST API accepts GID mostly.
    // Ideally we strip it for REST API compatibility.
    return variantId ? variantId.split('/').pop() : null;
  } catch (e) {
    log('ERROR', `GraphQL variant lookup failed for SKU ${sku} on ${store.name}: ${e.message}`);
    return null;
  }
}

app.listen(PORT, () => log('INFO', `Server running on ${PORT}`));