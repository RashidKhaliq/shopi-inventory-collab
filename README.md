# Multi-Store Shopify Inventory Sync (Next.js + Serverless + Supabase)

A production-ready, serverless application for **multi-store Shopify inventory synchronization** and **automated B2B dropship order fulfillment**. Designed exclusively for Vercel Serverless Functions using Next.js 14 App Router, TypeScript, Prisma ORM / PostgreSQL (Supabase), and Shopify Admin GraphQL API.

---

## 🌟 Key Architecture & Capabilities

- **100% Vercel Serverless Compatible**: Zero permanent background workers, Express servers, WebSockets, or Redis required.
- **Shopify Admin GraphQL Engine**: Queries order line items, product tags (`Supplier: Name`), and product metafields (`custom.supplier`).
- **Automated Dropship Order Creation**: When a customer places an order on Store A (e.g. `OTS-1005` containing `jacket-001` from Supplier: Rashid and `shirt-005` from Supplier: Hamza), the system creates a B2B fulfillment order on the target supplier's store (Store B/Hamza) tagged with `Soldby-Rashid` and `Automated Dropship`.
- **Cross-Store Inventory Synchronization**: Automatically updates available inventory quantities for matching SKUs across connected stores upon order creation or inventory changes to prevent overselling.
- **Database Idempotency Engine**: Uses PostgreSQL / Supabase with `ProcessedWebhook` table to guarantee zero duplicate webhook processing via `X-Shopify-Webhook-Id`.
- **Loop Protection**: Built-in guard logic prevents infinite order loops by ignoring orders tagged `Automated Dropship` or `Soldby-`.
- **Vercel Geist Admin Dashboard**: Modern responsive UI with live store health indicators, order audit trail, searchable log stream, and interactive SKU test simulator.

---

## 🗄️ Database Setup (Supabase / PostgreSQL)

1. Create a free PostgreSQL database on [Supabase](https://supabase.com) or [Vercel Postgres](https://vercel.com/postgres).
2. Copy your PostgreSQL Connection String (Transaction Pooler or Direct URL).
3. Set the `DATABASE_URL` environment variable:
   ```env
   DATABASE_URL="postgresql://postgres:PASSWORD@db.xxxx.supabase.co:5432/postgres?pgboiler=true"
   ```
4. Run Prisma schema migration to initialize tables:
   ```bash
   npx prisma db push
   ```

---

## 🔑 Environment Variables Setup

Configure the following environment variables in your local `.env` or Vercel Project Settings:

```env
# Database
DATABASE_URL="postgresql://postgres:PASSWORD@db.xxxx.supabase.co:5432/postgres"

# Shopify App OAuth (From Shopify Partner Dashboard)
SHOPIFY_API_KEY="your_shopify_app_client_id"
SHOPIFY_API_SECRET="your_shopify_app_client_secret"

# Store A Configuration (Optional pre-seeded defaults)
STORE_A_URL="rashidstore.myshopify.com"
STORE_A_ACCESS_TOKEN="shpat_xxxxxxxxxxxxxxxx"
STORE_A_OWNER_EMAIL="rashidkhaliq88@gmail.com"
STORE_A_WEBHOOK_SECRET="shpss_a1b2c3d4..."

# Store B Configuration (Optional pre-seeded defaults)
STORE_B_URL="hamzastore.myshopify.com"
STORE_B_ACCESS_TOKEN="shpat_yyyyyyyyyyyyyyyy"
STORE_B_OWNER_EMAIL="Hamzatvc@gmail.com"
STORE_B_WEBHOOK_SECRET="shpss_e5f6g7h8..."
```

---

## 🛍️ Shopify App Configuration (Shopify Partners)

1. Go to [Shopify Partners Dashboard](https://partners.shopify.com) > **Apps** > **Create app**.
2. Set **Allowed redirection URL(s)** to:
   ```
   https://your-app.vercel.app/api/auth/callback
   ```
3. Set **App Scopes**:
   ```
   read_products,write_products,read_orders,write_orders,read_inventory,write_inventory
   ```

---

## ⚡ Webhook Registration

Register the serverless webhook URL in each connected store's Shopify Admin (**Settings > Notifications > Webhooks**):

- **Webhook URL**: `https://your-app.vercel.app/api/webhooks/shopify`
- **Events to Subscribe**:
  - `orders/create` (JSON)
  - `inventory_levels/update` (JSON)

---

## 🚀 Deployment to Vercel

```bash
git add .
git commit -m "Deploy production Next.js multi-store inventory sync app"
git push origin main
```

1. Import your repository in [Vercel](https://vercel.com/new).
2. Add your environment variables under **Settings > Environment Variables**.
3. Click **Deploy**. Vercel will automatically build the Next.js App Router project!

---

## 🧪 Local Development

```bash
npm install
npx prisma db push
npm run dev
```

Open `http://localhost:3000` in your browser to access the Vercel-themed Admin Dashboard.
