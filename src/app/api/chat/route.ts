import { runAgent } from '../../../lib/agent';

export async function POST(request: Request) {
  const body = await request.json();
  const message = typeof body.message === 'string' ? body.message.trim() : '';
  const tzOffsetMinutes = typeof body.tzOffsetMinutes === 'number' ? body.tzOffsetMinutes : 0;

  if (!message) {
    return Response.json({ error: 'message is required' }, { status: 400 });
  }

  const encoder = new TextEncoder();
  let open = true;

  const stream = new ReadableStream({
    async start(controller) {
      // Send one event to the browser as one line of JSON.
      const send = (event: object) => {
        if (!open) return;
        try {
          controller.enqueue(encoder.encode(JSON.stringify(event) + '\n'));
        } catch {
          open = false;
        }
      };

      try {
        await runAgent({ message, tzOffsetMinutes }, send);
      } catch (error) {
        console.error(error);
        send({ type: 'error', message: 'Something went wrong on the server.' });
      }

      if (open) controller.close();
    },
    cancel() {
      open = false;
    },
  });

  return new Response(stream, { headers: { 'Content-Type': 'application/x-ndjson' } });
}