// app/api/inventory-analytics/route.ts - Inventory Dashboard & Analytics API
import { NextRequest, NextResponse } from 'next/server';
import { db } from '@/lib/db';
import { cleanShopDomain } from '@/lib/shopify';
import axios from 'axios';

interface ProductTypeMetrics {
  productType: string;
  totalProducts: number;
  soldProducts: number;
  stockValue: number;
  sellThroughRatio: number;
}

export async function GET(req: NextRequest) {
  try {
    const { searchParams } = new URL(req.url);
    const filterStoreDomain = searchParams.get('storeDomain') || searchParams.get('store');

    const allStores = await db.getAllStores();

    // Filter stores if storeDomain query param is passed and not "all"
    let targetStores = allStores;
    if (filterStoreDomain && filterStoreDomain !== 'all') {
      const cleanFilter = cleanShopDomain(filterStoreDomain);
      targetStores = allStores.filter(s => cleanShopDomain(s.shopDomain) === cleanFilter);
    }

    const typeMap: Map<string, {
      totalProducts: number;
      soldProducts: number;
      stockValue: number;
    }> = new Map();

    let grandTotalProducts = 0;
    let grandSoldProducts = 0;
    let grandStockValue = 0;

    // Fetch active, draft, and archived products across connected stores
    for (const store of targetStores) {
      if (!store.isActive || !store.accessToken) continue;
      const domain = cleanShopDomain(store.shopDomain);

      try {
        let products: any[] = [];
        let url: string | null = `https://${domain}/admin/api/2024-01/products.json?limit=250&status=any`;

        // Paginate to fetch 100% of products (active, draft, archived)
        while (url) {
          const res: any = await axios.get(url, {
            headers: { 'X-Shopify-Access-Token': store.accessToken },
            timeout: 12000
          });

          const batch = res.data?.products || [];
          products.push(...batch);

          const linkHeader = res.headers['link'] || res.headers['Link'];
          let nextUrl: string | null = null;
          if (linkHeader) {
            const match = linkHeader.match(/<([^>]+)>;\s*rel="next"/i);
            if (match) nextUrl = match[1];
          }
          url = nextUrl;
        }

        for (const p of products) {
          const pType = (p.product_type && p.product_type.trim()) ? p.product_type.trim() : 'General / Apparel';

          if (!typeMap.has(pType)) {
            typeMap.set(pType, {
              totalProducts: 0,
              soldProducts: 0,
              stockValue: 0
            });
          }

          const group = typeMap.get(pType)!;
          group.totalProducts++;
          grandTotalProducts++;

          let productAvailableQty = 0;
          let productStockValue = 0;

          if (Array.isArray(p.variants)) {
            for (const v of p.variants) {
              const qty = v.inventory_quantity || 0;
              const price = parseFloat(v.price || '0') || 0;
              if (qty > 0) {
                productAvailableQty += qty;
                productStockValue += (qty * price);
              }
            }
          }

          group.stockValue += productStockValue;
          grandStockValue += productStockValue;

          // Product with 0 inventory = Sold Product (active + draft + archived)
          if (productAvailableQty <= 0) {
            group.soldProducts++;
            grandSoldProducts++;
          }
        }
      } catch (err: any) {
        console.warn(`Failed to fetch products for store ${store.name}:`, err.message);
      }
    }

    const rows: ProductTypeMetrics[] = [];
    for (const [pType, group] of typeMap.entries()) {
      const sellThroughRatio = group.totalProducts > 0
        ? Math.round((group.soldProducts / group.totalProducts) * 1000) / 10
        : 0;

      rows.push({
        productType: pType,
        totalProducts: group.totalProducts,
        soldProducts: group.soldProducts,
        stockValue: Math.round(group.stockValue * 100) / 100,
        sellThroughRatio
      });
    }

    rows.sort((a, b) => b.totalProducts - a.totalProducts);

    const grandSellThroughRatio = grandTotalProducts > 0
      ? Math.round((grandSoldProducts / grandTotalProducts) * 1000) / 10
      : 0;

    const summaryPayload = {
      totalProducts: grandTotalProducts,
      soldProducts: grandSoldProducts,
      stockValue: Math.round(grandStockValue * 100) / 100,
      sellThroughRatio: grandSellThroughRatio,
      selectedStoreDomain: filterStoreDomain || 'all'
    };

    // Save summary in database persistently
    await db.saveInventorySummary(summaryPayload);

    return NextResponse.json({
      summary: summaryPayload,
      rows,
      stores: allStores.map(s => ({ shopDomain: s.shopDomain, name: s.name, supplierName: s.supplierName }))
    });
  } catch (err: any) {
    const cached = db.getInventorySummary();
    if (cached) {
      return NextResponse.json({ summary: cached, rows: [], stores: [] });
    }
    return NextResponse.json({ error: err.message }, { status: 500 });
  }
}
