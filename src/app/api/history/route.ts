import { recentMessages } from '../../../lib/memory';

export const dynamic = 'force-dynamic';

export function GET() {
  return Response.json({ messages: recentMessages(200) });
}