export const dynamic = 'force-dynamic';

export function GET() {
  return Response.json(
    {
      status: 'alive',
      service: 'web',
      lifecycle: 'ready',
      authority: 'none',
      checkedAt: new Date().toISOString(),
      build: process.env['BUILD_ID'] ?? 'development',
    },
    { status: 200, headers: { 'cache-control': 'no-store' } },
  );
}
