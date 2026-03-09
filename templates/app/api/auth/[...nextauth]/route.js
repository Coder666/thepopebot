// force-dynamic prevents Next.js from trying to statically analyze this route
// at build time, which would fail because NextAuth imports next/server at load time.
export const dynamic = 'force-dynamic';

export { GET, POST } from 'thepopebot/auth';
