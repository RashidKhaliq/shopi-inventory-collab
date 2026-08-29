// app/api/logs/route.ts - Activity Log API
import { NextRequest, NextResponse } from 'next/server';
import { db } from '@/lib/db';

export async function GET(req: NextRequest) {
  const logs = await db.getRecentLogs(100);
  return NextResponse.json({ logs });
}
