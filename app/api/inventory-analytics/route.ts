// app/api/inventory-analytics/route.ts - Inventory Dashboard & Analytics API
import { NextRequest, NextResponse } from 'next/server';
import { db } from '@/lib/db';
import { cleanShopDomain } from '@/lib/shopify';
import axios from 'axios';

interface ProductTypeMetrics {
  productType: string;
  totalProducts: number;
  afsProducts: number;
  afsQty: number;
  soldQty: number;
  totalQty: number;
  stockValue: number;
  sellThroughRatio: number; // (soldQty / (soldQty + afsQty)) * 100
}

export async function GET(req: NextRequest) {
  try {
    const stores = await db.getAllStores();
    const orderSyncs = await db.getOrderSyncs(500);

    const typeMap: Map<string, {
      totalProducts: Set<string>;
      afsProducts: Set<string>;
      afsQty: number;
      soldQty: number;
      totalValue: number;
    }> = new Map();

    // Map sold quantities from Order Sync History
    const skuSoldMap: Map<string, number> = new Map();
    for (const sync of orderSyncs) {
      if (sync.status === 'SUCCESS' && sync.skus) {
        // e.g. "shirt-01 (x2), pant-02 (x1)"
        const parts = sync.skus.split(',');
        for (const part of parts) {
          const match = part.trim().match(/^(.+?)\s*\(\s*x(\d+)\s*\)$/i);
          if (match) {
            const sku = match[1].trim().toLowerCase();
            const qty = parseInt(match[2], 10) || 1;
            skuSoldMap.set(sku, (skuSoldMap.get(sku) || 0) + qty);
          }
        }
      }
    }

    // Fetch products across connected stores
    for (const store of stores) {
      if (!store.isActive || !store.accessToken) continue;
      const domain = cleanShopDomain(store.shopDomain);

      try {
        const res = await axios.get(`https://${domain}/admin/api/2024-01/products.json?limit=250`, {
          headers: { 'X-Shopify-Access-Token': store.accessToken },
          timeout: 10000
        });

        const products = res.data?.products || [];

        for (const p of products) {
          const pType = (p.product_type && p.product_type.trim()) ? p.product_type.trim() : 'General / Apparel';
          const pId = String(p.id);

          if (!typeMap.has(pType)) {
            typeMap.set(pType, {
              totalProducts: new Set(),
              afsProducts: new Set(),
              afsQty: 0,
              soldQty: 0,
              totalValue: 0
            });
          }

          const group = typeMap.get(pType)!;
          group.totalProducts.add(pId);

          let productAvailable = 0;
          let productPriceSum = 0;
          let variantCount = 0;

          if (Array.isArray(p.variants)) {
            for (const v of p.variants) {
              const qty = v.inventory_quantity || 0;
              const price = parseFloat(v.price || '0') || 0;
              productAvailable += Math.max(0, qty);
              productPriceSum += price;
              variantCount++;

              if (v.sku) {
                const cleanSku = v.sku.trim().toLowerCase();
                if (skuSoldMap.has(cleanSku)) {
                  group.soldQty += skuSoldMap.get(cleanSku)!;
                }
              }
            }
          }

          group.afsQty += productAvailable;
          const avgPrice = variantCount > 0 ? (productPriceSum / variantCount) : 0;
          group.totalValue += (productAvailable * avgPrice);

          if (productAvailable > 0 && p.status === 'active') {
            group.afsProducts.add(pId);
          }
        }
      } catch (err: any) {
        console.warn(`Failed to fetch products for store ${store.name}:`, err.message);
      }
    }

    // Convert map to metrics array
    const rows: ProductTypeMetrics[] = [];
    let grandAfsQty = 0;
    let grandSoldQty = 0;
    let grandStockValue = 0;
    let grandTotalProducts = 0;
    let grandAfsProducts = 0;

    for (const [pType, group] of typeMap.entries()) {
      const totalProds = group.totalProducts.size;
      const afsProds = group.afsProducts.size;
      const afsQty = group.afsQty;
      const soldQty = group.soldQty;
      const totalQty = afsQty + soldQty;
      const stockVal = Math.round(group.totalValue * 100) / 100;

      // Formula: Sell-Through % = (Sold Qty / (Sold Qty + AFS Qty)) * 100
      const sellThroughRatio = totalQty > 0
        ? Math.round((soldQty / totalQty) * 1000) / 10
        : 0;

      rows.push({
        productType: pType,
        totalProducts: totalProds,
        afsProducts: afsProds,
        afsQty,
        soldQty,
        totalQty,
        stockValue: stockVal,
        sellThroughRatio
      });

      grandAfsQty += afsQty;
      grandSoldQty += soldQty;
      grandStockValue += stockVal;
      grandTotalProducts += totalProds;
      grandAfsProducts += afsProds;
    }

    // Sort by Total Products descending
    rows.sort((a, b) => b.totalProducts - a.totalProducts);

    const grandTotalQty = grandAfsQty + grandSoldQty;
    const grandSellThroughRatio = grandTotalQty > 0
      ? Math.round((grandSoldQty / grandTotalQty) * 1000) / 10
      : 0;

    return NextResponse.json({
      summary: {
        totalProducts: grandTotalProducts,
        afsProducts: grandAfsProducts,
        afsQty: grandAfsQty,
        soldQty: grandSoldQty,
        totalQty: grandTotalQty,
        stockValue: Math.round(grandStockValue * 100) / 100,
        sellThroughRatio: grandSellThroughRatio
      },
      rows
    });
  } catch (err: any) {
    return NextResponse.json({ error: err.message }, { status: 500 });
  }
}
