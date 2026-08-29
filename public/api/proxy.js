export const config = {
  runtime: 'edge',
};

export default async function handler(request) {
  const url = new URL(request.url);
  const targetUrlStr = url.searchParams.get('url');

  if (!targetUrlStr) {
    return new Response('URL is required', { status: 400 });
  }

  let targetUrl;
  try {
    targetUrl = new URL(targetUrlStr);
  } catch {
    return new Response('Invalid URL', { status: 400 });
  }

  if (targetUrl.protocol !== 'http:' && targetUrl.protocol !== 'https:') {
    return new Response('Only HTTP/HTTPS protocols are allowed', { status: 403 });
  }

  try {
    const headers = new Headers();
    if (request.headers.get('Accept')) {
      headers.set('Accept', request.headers.get('Accept'));
    }
    headers.set('User-Agent', 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) VercelStaticProxy');

    const method = request.method === 'HEAD' ? 'HEAD' : 'GET';

    const modifiedRequest = new Request(targetUrl.toString(), {
      headers,
      method,
      redirect: 'follow'
    });

    const response = await fetch(modifiedRequest);

    const newResponse = new Response(response.body, response);
    newResponse.headers.set('Access-Control-Allow-Origin', '*');
    newResponse.headers.set('X-Content-Type-Options', 'nosniff');

    return newResponse;
  } catch (e) {
    return new Response(`Static Proxy Error: ${e.message}`, { status: 500 });
  }
}
