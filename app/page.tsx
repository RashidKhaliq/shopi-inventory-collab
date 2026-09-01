'use client';

import React, { useState, useEffect } from 'react';

export default function Dashboard() {
  const [activeTab, setActiveTab] = useState<'stores' | 'orders' | 'logs' | 'simulator' | 'webhooks'>('stores');
  const [statusData, setStatusData] = useState<any>(null);
  const [stores, setStores] = useState<any[]>([]);
  const [orderSyncs, setOrderSyncs] = useState<any[]>([]);
  const [logs, setLogs] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);

  // Form states for manual store connection
  const [newStoreDomain, setNewStoreDomain] = useState('');
  const [newStoreName, setNewStoreName] = useState('');
  const [newAccessToken, setNewAccessToken] = useState('');
  const [newOwnerEmail, setNewOwnerEmail] = useState('');
  const [newSupplierName, setNewSupplierName] = useState('');
  const [addStoreSuccess, setAddStoreSuccess] = useState('');

  // Form states for SKU Simulator
  const [simSource, setSimSource] = useState('');
  const [simTarget, setSimTarget] = useState('');
  const [simSku, setSimSku] = useState('');
  const [simResult, setSimResult] = useState<any>(null);
  const [simLoading, setSimLoading] = useState(false);

  // Sync today's orders state
  const [syncingToday, setSyncingToday] = useState(false);

  const handleSyncTodayOrders = async () => {
    setSyncingToday(true);
    try {
      const res = await fetch('/api/orders', { method: 'POST' });
      const data = await res.json();
      if (res.ok) {
        alert(`Today's Order Sync Completed!\nScanned: ${data.totalOrdersFetchedToday || 0} order(s) placed today.`);
        await Promise.all([fetchOrders(), fetchLogs()]);
      } else {
        alert(data.error || 'Failed to sync today orders');
      }
    } catch (e: any) {
      alert('Error syncing today orders: ' + e.message);
    } finally {
      setSyncingToday(false);
    }
  };

  useEffect(() => {
    fetchData();
    const interval = setInterval(() => {
      fetchLogs();
      fetchOrders();
    }, 5000);
    return () => clearInterval(interval);
  }, []);

  const fetchData = async () => {
    setLoading(true);
    await Promise.all([fetchStatus(), fetchStores(), fetchOrders(), fetchLogs()]);
    setLoading(false);
  };

  const fetchStatus = async () => {
    try {
      const res = await fetch('/api/status');
      const data = await res.json();
      setStatusData(data);
    } catch (e) {
      console.error('Error fetching status', e);
    }
  };

  const fetchStores = async () => {
    try {
      const res = await fetch('/api/stores');
      const data = await res.json();
      setStores(data.stores || []);
      if (data.stores && data.stores.length >= 2) {
        setSimSource(data.stores[0].shopDomain);
        setSimTarget(data.stores[1].shopDomain);
      }
    } catch (e) {
      console.error('Error fetching stores', e);
    }
  };

  const fetchOrders = async () => {
    try {
      const res = await fetch('/api/orders');
      const data = await res.json();
      setOrderSyncs(data.orderSyncs || []);
    } catch (e) {
      console.error('Error fetching order syncs', e);
    }
  };

  const fetchLogs = async () => {
    try {
      const res = await fetch('/api/logs');
      const data = await res.json();
      setLogs(data.logs || []);
    } catch (e) {
      console.error('Error fetching logs', e);
    }
  };

  const handleAddStore = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!newStoreDomain || !newAccessToken || !newOwnerEmail || !newSupplierName) {
      alert('Please fill in all required fields');
      return;
    }

    try {
      const res = await fetch('/api/stores', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          shopDomain: newStoreDomain,
          name: newStoreName || `${newSupplierName} Store`,
          accessToken: newAccessToken,
          ownerEmail: newOwnerEmail,
          supplierName: newSupplierName
        })
      });

      const data = await res.json();
      if (res.ok) {
        setAddStoreSuccess(`Successfully connected store '${data.store.name}'!`);
        setNewStoreDomain('');
        setNewStoreName('');
        setNewAccessToken('');
        setNewOwnerEmail('');
        setNewSupplierName('');
        fetchData();
      } else {
        alert(data.error || 'Failed to save store');
      }
    } catch (err: any) {
      alert('Error adding store: ' + err.message);
    }
  };

  const handleRunSimulator = async () => {
    if (!simSource || !simTarget || !simSku) {
      alert('Please select Source Store, Target Store, and enter a SKU');
      return;
    }

    setSimLoading(true);
    setSimResult(null);

    try {
      const res = await fetch('/api/test-sync', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          sourceDomain: simSource,
          targetDomain: simTarget,
          sku: simSku
        })
      });

      const data = await res.json();
      setSimResult(data);
      await Promise.all([fetchLogs(), fetchOrders()]);
    } catch (e: any) {
      alert('Simulation error: ' + e.message);
    } finally {
      setSimLoading(false);
    }
  };

  const getOrigin = () => {
    if (typeof window !== 'undefined') return window.location.origin;
    return 'https://your-app.vercel.app';
  };

  const copyToClipboard = (text: string) => {
    navigator.clipboard.writeText(text);
    alert('Copied Webhook URL to clipboard!');
  };

  return (
    <div className="min-h-screen flex flex-col bg-black text-neutral-200">
      {/* HEADER */}
      <header className="border-b border-neutral-800 bg-black/80 backdrop-blur-md sticky top-0 z-50">
        <div className="max-w-7xl mx-auto px-6 py-4 flex items-center justify-between">
          <div className="flex items-center gap-3">
            <svg className="w-6 h-6 fill-white" viewBox="0 0 76 65">
              <path d="M37.5274 0L75.0548 65H0L37.5274 0Z" />
            </svg>
            <span className="font-semibold text-lg text-white tracking-tight">Shopify Sync Engine</span>
            <span className="text-xs bg-neutral-900 border border-neutral-700 text-neutral-400 px-2 py-0.5 rounded-full font-medium">
              Vercel Serverless
            </span>
          </div>

          <div className="flex items-center gap-4">
            <div className="flex items-center gap-2 bg-neutral-950 border border-neutral-800 px-3.5 py-1.5 rounded-full text-xs font-medium">
              <span className={`w-2.5 h-2.5 rounded-full ${statusData?.overallStatus === 'HEALTHY' ? 'bg-emerald-400 glow-green' : 'bg-amber-400 glow-red'}`} />
              <span className="text-neutral-300">
                {statusData?.overallStatus === 'HEALTHY' ? 'System Operational' : 'Action Required'}
              </span>
            </div>
            <button
              onClick={fetchData}
              className="bg-neutral-900 hover:bg-neutral-800 border border-neutral-700 text-white text-xs px-3 py-1.5 rounded-md font-medium transition"
            >
              🔄 Refresh Status
            </button>
          </div>
        </div>
      </header>

      {/* MAIN CONTAINER */}
      <main className="max-w-7xl mx-auto px-6 pt-8 pb-16 flex-1 w-full">
        {/* HERO BANNER */}
        <div className="mb-8">
          <h1 className="text-3xl font-bold text-white tracking-tight">Multi-Store Inventory &amp; Order Sync</h1>
          <p className="text-neutral-400 text-sm mt-1">
            Automated B2B supplier order fulfillment and SKU inventory synchronization powered by Shopify GraphQL API.
          </p>
        </div>

        {/* TABS NAVIGATION */}
        <div className="flex border-b border-neutral-800 mb-8 gap-2">
          {[
            { id: 'stores', label: `Connected Stores (${stores.length})` },
            { id: 'orders', label: `Order Sync History (${orderSyncs.length})` },
            { id: 'logs', label: `Live Activity Stream (${logs.length})` },
            { id: 'simulator', label: '🧪 SKU Simulator' },
            { id: 'webhooks', label: 'Webhook Endpoints' }
          ].map(tab => (
            <button
              key={tab.id}
              onClick={() => setActiveTab(tab.id as any)}
              className={`px-4 py-2.5 text-sm font-medium border-b-2 transition -mb-px ${
                activeTab === tab.id
                  ? 'border-white text-white'
                  : 'border-transparent text-neutral-400 hover:text-neutral-200'
              }`}
            >
              {tab.label}
            </button>
          ))}
        </div>

        {/* TAB 1: STORES */}
        {activeTab === 'stores' && (
          <div>
            <div className="grid grid-cols-1 md:grid-cols-2 gap-6 mb-8">
              {stores.map((st: any) => (
                <div key={st.id || st.shopDomain} className="bg-neutral-950 border border-neutral-800 rounded-xl p-6 hover:border-neutral-700 transition">
                  <div className="flex justify-between items-start mb-4">
                    <div>
                      <h3 className="text-lg font-semibold text-white">{st.name}</h3>
                      <p className="font-mono text-xs text-neutral-400 mt-0.5">{st.shopDomain}</p>
                    </div>
                    <span className="bg-emerald-950/80 border border-emerald-800 text-emerald-400 text-xs px-2.5 py-1 rounded-full font-medium">
                      ✓ Connected
                    </span>
                  </div>

                  <div className="space-y-2 text-xs divide-y divide-neutral-900">
                    <div className="flex justify-between pt-2">
                      <span className="text-neutral-400">Owner Email</span>
                      <span className="font-mono text-white">{st.ownerEmail}</span>
                    </div>
                    <div className="flex justify-between pt-2">
                      <span className="text-neutral-400">Supplier Tag Identifier</span>
                      <span className="font-mono text-emerald-400 font-medium">Supplier: {st.supplierName}</span>
                    </div>
                    <div className="flex justify-between pt-2">
                      <span className="text-neutral-400">Fulfills Soldby Tag</span>
                      <span className="font-mono text-white">Soldby-{st.supplierName}</span>
                    </div>
                  </div>
                </div>
              ))}
            </div>

            {/* ADD NEW STORE FORM */}
            <div className="bg-neutral-950 border border-neutral-800 rounded-xl p-6">
              <h3 className="text-lg font-semibold text-white mb-2">Connect New Independent Shopify Store</h3>
              <p className="text-xs text-neutral-400 mb-6">
                Enter your store details and Admin API Access Token to pair it for automated B2B dropship synchronization.
              </p>

              {addStoreSuccess && (
                <div className="mb-4 p-3 bg-emerald-950/50 border border-emerald-800 text-emerald-300 text-xs rounded-md">
                  {addStoreSuccess}
                </div>
              )}

              <form onSubmit={handleAddStore} className="grid grid-cols-1 md:grid-cols-2 gap-4">
                <div>
                  <label className="block text-xs text-neutral-300 mb-1">Shopify Store Domain *</label>
                  <input
                    type="text"
                    placeholder="example.myshopify.com"
                    value={newStoreDomain}
                    onChange={e => setNewStoreDomain(e.target.value)}
                    className="w-full bg-black border border-neutral-800 rounded-md px-3 py-2 text-xs text-white font-mono focus:outline-none focus:border-neutral-600"
                  />
                </div>

                <div>
                  <label className="block text-xs text-neutral-300 mb-1">Store Display Name</label>
                  <input
                    type="text"
                    placeholder="e.g. Rashid Store"
                    value={newStoreName}
                    onChange={e => setNewStoreName(e.target.value)}
                    className="w-full bg-black border border-neutral-800 rounded-md px-3 py-2 text-xs text-white focus:outline-none focus:border-neutral-600"
                  />
                </div>

                <div>
                  <label className="block text-xs text-neutral-300 mb-1">Admin API Access Token (shpat_*) *</label>
                  <input
                    type="password"
                    placeholder="shpat_xxxxxxxxxxxxxxxx"
                    value={newAccessToken}
                    onChange={e => setNewAccessToken(e.target.value)}
                    className="w-full bg-black border border-neutral-800 rounded-md px-3 py-2 text-xs text-white font-mono focus:outline-none focus:border-neutral-600"
                  />
                </div>

                <div>
                  <label className="block text-xs text-neutral-300 mb-1">Owner Email Address *</label>
                  <input
                    type="email"
                    placeholder="owner@example.com"
                    value={newOwnerEmail}
                    onChange={e => setNewOwnerEmail(e.target.value)}
                    className="w-full bg-black border border-neutral-800 rounded-md px-3 py-2 text-xs text-white font-mono focus:outline-none focus:border-neutral-600"
                  />
                </div>

                <div>
                  <label className="block text-xs text-neutral-300 mb-1">Supplier Name Tag (e.g. Rashid or Hamza) *</label>
                  <input
                    type="text"
                    placeholder="e.g. Rashid"
                    value={newSupplierName}
                    onChange={e => setNewSupplierName(e.target.value)}
                    className="w-full bg-black border border-neutral-800 rounded-md px-3 py-2 text-xs text-white font-mono focus:outline-none focus:border-neutral-600"
                  />
                </div>

                <div className="flex items-end">
                  <button type="submit" className="w-full bg-white hover:bg-neutral-200 text-black font-semibold text-xs py-2.5 rounded-md transition">
                    + Connect Store Credentials
                  </button>
                </div>
              </form>
            </div>
          </div>
        )}

        {/* TAB 2: ORDER SYNCS */}
        {activeTab === 'orders' && (
          <div className="bg-neutral-950 border border-neutral-800 rounded-xl overflow-hidden">
            <div className="p-4 border-b border-neutral-800 flex justify-between items-center flex-wrap gap-2">
              <div>
                <h3 className="font-semibold text-sm text-white">Order Synchronization Audit Trail</h3>
                <p className="text-xs text-neutral-400">Includes all orders placed today &amp; cross-store sync history</p>
              </div>
              <div className="flex items-center gap-3">
                <button
                  onClick={handleSyncTodayOrders}
                  disabled={syncingToday}
                  className="bg-emerald-950 hover:bg-emerald-900 border border-emerald-800 text-emerald-400 text-xs px-3.5 py-1.5 rounded-md font-medium transition flex items-center gap-1.5"
                >
                  {syncingToday ? '🔄 Syncing Today\'s Orders...' : '🔄 Sync Today\'s Orders from Shopify'}
                </button>
                <span className="text-xs text-neutral-400">Total Records: {orderSyncs.length}</span>
              </div>
            </div>

            <div className="overflow-x-auto">
              <table className="w-full text-left text-xs">
                <thead className="bg-neutral-900/50 text-neutral-400 font-medium">
                  <tr>
                    <th className="p-3">Source Store</th>
                    <th className="p-3">Source Order</th>
                    <th className="p-3">Supplier Store</th>
                    <th className="p-3">Supplier Order Created</th>
                    <th className="p-3">SKUs Synced</th>
                    <th className="p-3">Status</th>
                    <th className="p-3">Timestamp</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-neutral-900 font-mono">
                  {orderSyncs.length === 0 ? (
                    <tr>
                      <td colSpan={7} className="p-6 text-center text-neutral-500 font-sans">
                        No order synchronization records logged yet.
                      </td>
                    </tr>
                  ) : (
                    orderSyncs.map((ord: any) => (
                      <tr key={ord.id} className="hover:bg-neutral-900/30">
                        <td className="p-3 text-neutral-300">{ord.sourceShopDomain}</td>
                        <td className="p-3 text-white font-semibold">{ord.sourceOrderName}</td>
                        <td className="p-3 text-neutral-300">{ord.targetShopDomain}</td>
                        <td className="p-3 text-emerald-400 font-semibold">{ord.targetOrderName || '-'}</td>
                        <td className="p-3 text-neutral-300">{ord.skus}</td>
                        <td className="p-3">
                          <span
                            className={`px-2 py-0.5 rounded text-[11px] font-medium ${
                              ord.status === 'SUCCESS'
                                ? 'bg-emerald-950 text-emerald-400 border border-emerald-800'
                                : ord.status === 'SKIPPED'
                                ? 'bg-amber-950 text-amber-400 border border-amber-800'
                                : 'bg-rose-950 text-rose-400 border border-rose-800'
                            }`}
                          >
                            {ord.status}
                          </span>
                        </td>
                        <td className="p-3 text-neutral-500">{new Date(ord.createdAt).toLocaleString()}</td>
                      </tr>
                    ))
                  )}
                </tbody>
              </table>
            </div>
          </div>
        )}

        {/* TAB 3: LOGS */}
        {activeTab === 'logs' && (
          <div className="bg-neutral-950 border border-neutral-800 rounded-xl overflow-hidden">
            <div className="p-4 border-b border-neutral-800 flex justify-between items-center">
              <h3 className="font-semibold text-sm text-white">Vercel Log Stream</h3>
              <button onClick={fetchLogs} className="text-xs text-neutral-400 hover:text-white">Refresh Stream</button>
            </div>

            <div className="p-4 max-h-[500px] overflow-y-auto font-mono text-xs space-y-2 bg-black">
              {logs.map((l: any, i: number) => (
                <div key={l.id || i} className="flex gap-3 text-neutral-300">
                  <span className="text-neutral-500 shrink-0">
                    [{l.createdAt ? new Date(l.createdAt).toLocaleTimeString() : 'Time'}]
                  </span>
                  <span className={`font-semibold shrink-0 w-14 ${l.level === 'ERROR' ? 'text-rose-400' : l.level === 'WARN' ? 'text-amber-400' : 'text-blue-400'}`}>
                    {l.level}
                  </span>
                  <span className="break-all">{l.message}</span>
                </div>
              ))}
            </div>
          </div>
        )}

        {/* TAB 4: SIMULATOR */}
        {activeTab === 'simulator' && (
          <div className="bg-neutral-950 border border-neutral-800 rounded-xl p-6">
            <h3 className="text-lg font-semibold text-white mb-2">Test Dropship SKU Mapping Simulator</h3>
            <p className="text-xs text-neutral-400 mb-6">
              Test whether a SKU on your selling store correctly resolves to a variant ID on your target supplier store without placing live orders.
            </p>

            <div className="grid grid-cols-1 md:grid-cols-3 gap-4 mb-6">
              <div>
                <label className="block text-xs text-neutral-300 mb-1">Source Selling Store</label>
                <select
                  value={simSource}
                  onChange={e => setSimSource(e.target.value)}
                  className="w-full bg-black border border-neutral-800 rounded-md px-3 py-2 text-xs text-white focus:outline-none"
                >
                  <option value="">Select Store...</option>
                  {stores.map(s => (
                    <option key={s.shopDomain} value={s.shopDomain}>{s.name} ({s.shopDomain})</option>
                  ))}
                </select>
              </div>

              <div>
                <label className="block text-xs text-neutral-300 mb-1">Target Supplier Store</label>
                <select
                  value={simTarget}
                  onChange={e => setSimTarget(e.target.value)}
                  className="w-full bg-black border border-neutral-800 rounded-md px-3 py-2 text-xs text-white focus:outline-none"
                >
                  <option value="">Select Store...</option>
                  {stores.map(s => (
                    <option key={s.shopDomain} value={s.shopDomain}>{s.name} ({s.shopDomain})</option>
                  ))}
                </select>
              </div>

              <div>
                <label className="block text-xs text-neutral-300 mb-1">Product SKU (e.g. jacket-001)</label>
                <input
                  type="text"
                  placeholder="jacket-001"
                  value={simSku}
                  onChange={e => setSimSku(e.target.value)}
                  className="w-full bg-black border border-neutral-800 rounded-md px-3 py-2 text-xs text-white font-mono focus:outline-none"
                />
              </div>
            </div>

            <button
              onClick={handleRunSimulator}
              disabled={simLoading}
              className="bg-white hover:bg-neutral-200 text-black font-semibold text-xs px-6 py-2.5 rounded-md transition"
            >
              {simLoading ? 'Running Simulation...' : '🧪 Execute Test Sync'}
            </button>

            {simResult && (
              <div className="mt-6 p-4 bg-black border border-neutral-800 rounded-md font-mono text-xs">
                <div className={`font-semibold mb-2 ${simResult.success ? 'text-emerald-400' : 'text-rose-400'}`}>
                  Simulation Outcome: {simResult.success ? 'SUCCESS ✓' : 'FAILED ✕'}
                </div>
                <div className="space-y-1 text-neutral-300">
                  {simResult.trace?.map((t: string, i: number) => (
                    <div key={i}>• {t}</div>
                  ))}
                </div>
              </div>
            )}
          </div>
        )}

        {/* TAB 5: WEBHOOKS */}
        {activeTab === 'webhooks' && (
          <div className="space-y-4">
            <div className="bg-neutral-950 border border-neutral-800 rounded-xl p-6">
              <h3 className="text-lg font-semibold text-white mb-2">Shopify Webhook Configuration Guide</h3>
              <p className="text-xs text-neutral-400 mb-4">
                Register this serverless URL in each connected store's Shopify Admin (&gt; Settings &gt; Notifications &gt; Webhooks) for <strong>Order Creation</strong> and <strong>Inventory Level Updates</strong>.
              </p>

              <div className="bg-black border border-neutral-800 rounded-md p-4 flex justify-between items-center font-mono text-xs text-emerald-400 mb-6">
                <span>{`${getOrigin()}/api/webhooks/shopify`}</span>
                <button
                  onClick={() => copyToClipboard(`${getOrigin()}/api/webhooks/shopify`)}
                  className="bg-neutral-800 hover:bg-neutral-700 text-white text-xs px-3 py-1 rounded"
                >
                  📋 Copy Endpoint URL
                </button>
              </div>

              <div className="space-y-2 text-xs text-neutral-300">
                <p><strong>Recommended Webhook Event Subscriptions (Format: JSON):</strong></p>
                <ul className="list-disc pl-5 space-y-1 font-mono text-neutral-400">
                  <li><code>orders/create</code> (Order Creation &amp; B2B Fulfillment Trigger)</li>
                  <li><code>orders/fulfilled</code> (Tracking Number &amp; Delivery Status Sync)</li>
                  <li><code>orders/updated</code> (Order Modification Notifications)</li>
                  <li><code>orders/paid</code> (Payment Status Events)</li>
                  <li><code>orders/cancelled</code> (Order Cancellation Alerts)</li>
                  <li><code>inventory_levels/update</code> (Real-Time SKU Inventory Level Sync)</li>
                </ul>
              </div>
            </div>
          </div>
        )}
      </main>

      {/* FOOTER */}
      <footer className="max-w-7xl mx-auto px-6 py-6 border-t border-neutral-900 text-xs text-neutral-500 flex justify-between w-full">
        <div>Deployed on Vercel Serverless Architecture</div>
        <div>Shopify Multi-Store Inventory Sync v2.0</div>
      </footer>
    </div>
  );
}
