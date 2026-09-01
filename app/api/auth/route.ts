// app/api/auth/route.ts - Admin Dashboard Authentication & Password Reset API
import { NextRequest, NextResponse } from 'next/server';
import { db } from '@/lib/db';

export async function GET(req: NextRequest) {
  return NextResponse.json({
    authRequired: true,
    defaultPasswordSet: !process.env.DASHBOARD_PASSWORD
  });
}

export async function POST(req: NextRequest) {
  try {
    const body = await req.json();
    const { password } = body || {};

    const configuredPassword = db.getDashboardPassword();

    if (password === configuredPassword) {
      await db.addLog('INFO', '🔑 Admin Dashboard unlocked successfully.', 'auth');
      return NextResponse.json({
        success: true,
        token: `auth_${Date.now()}_${Math.random().toString(36).substring(2, 8)}`
      });
    }

    await db.addLog('WARN', '🛑 Failed Dashboard unlock attempt with incorrect password.', 'auth');
    return NextResponse.json({ error: 'Incorrect password. Access denied.' }, { status: 401 });
  } catch (err: any) {
    return NextResponse.json({ error: err.message }, { status: 500 });
  }
}

export async function PUT(req: NextRequest) {
  try {
    const body = await req.json();
    const { currentPassword, newPassword } = body || {};

    const configuredPassword = db.getDashboardPassword();

    if (currentPassword !== configuredPassword) {
      return NextResponse.json({ error: 'Current password does not match.' }, { status: 400 });
    }

    if (!newPassword || newPassword.trim().length < 6) {
      return NextResponse.json({ error: 'New password must be at least 6 characters long.' }, { status: 400 });
    }

    const trimmedNew = newPassword.trim();
    db.setDashboardPassword(trimmedNew);
    process.env.DASHBOARD_PASSWORD = trimmedNew;

    await db.addLog('INFO', '🔒 Admin Dashboard password updated successfully.', 'auth');

    return NextResponse.json({
      success: true,
      message: 'Password updated successfully! Next time log in with your new password.'
    });
  } catch (err: any) {
    return NextResponse.json({ error: err.message }, { status: 500 });
  }
}
