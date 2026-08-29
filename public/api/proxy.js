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
    const modifiedRequest = new Request(targetUrl.toString(), {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
        'Accept': request.headers.get('Accept') || '*/*',
        'Accept-Language': 'ja,en-US;q=0.9,en;q=0.8'
      },
      method: request.method,
      redirect: 'follow'
    });

    const response = await fetch(modifiedRequest);
    const contentType = response.headers.get('content-type') || '';
    const origin = `${targetUrl.protocol}//${targetUrl.host}`;
    const proxyBase = `/api/proxy?url=`;

    // 1. HTMLの場合：中のリンク（href, src, action等）をすべてプロキシ経由に書き換える
    if (contentType.includes('text/html')) {
      let html = await response.text();

      // 絶対パス・ルート相対パスを書き換え
      // 例: /about -> /api/proxy?url=https://example.com/about
      html = html.replace(/(href|src|action)=["'](\/[^"']*)["']/gi, (match, attr, path) => {
        if (path.startsWith('//')) {
          return `${attr}="${proxyBase}${encodeURIComponent(targetUrl.protocol + path)}"`;
        }
        return `${attr}="${proxyBase}${encodeURIComponent(origin + path)}"`;
      });

      // 完全な外部URL（http/https）もプロキシ経由にする（必要に応じてサイト内遷移を維持するため）
      html = html.replace(/(href|src)=["'](https?:\/\/[^"']+)["']/gi, (match, attr, fullUrl) => {
        // 同じドメイン内のURLならプロキシ経由にする
        if (fullUrl.startsWith(origin)) {
          return `${attr}="${proxyBase}${encodeURIComponent(fullUrl)}"`;
        }
        return match;
      });

      const newResponse = new Response(html, response);
      newResponse.headers.set('Access-Control-Allow-Origin', '*');
      newResponse.headers.delete('X-Frame-Options');
      newResponse.headers.delete('Content-Security-Policy');
      return newResponse;
    }

    // 2. CSSの場合：CSS内のurl()（画像やフォントの読み込み）を書き換える
    if (contentType.includes('text/css')) {
      let css = await response.text();
      css = css.replace(/url\(\s*["']?([^"')]+)["']?\s*\)/gi, (match, assetPath) => {
        let absoluteUrl = assetPath;
        if (assetPath.startsWith('http://') || assetPath.startsWith('https://')) {
          absoluteUrl = assetPath;
        } else if (assetPath.startsWith('/')) {
          absoluteUrl = origin + assetPath;
        } else {
          // 相対パスの解決
          const basePath = targetUrl.pathname.substring(0, targetUrl.pathname.lastIndexOf('/') + 1);
          absoluteUrl = `${origin}${basePath}${assetPath}`;
        }
        return `url("${proxyBase}${encodeURIComponent(absoluteUrl)}")`;
      });

      const newResponse = new Response(css, response);
      newResponse.headers.set('Access-Control-Allow-Origin', '*');
      newResponse.headers.delete('X-Frame-Options');
      newResponse.headers.delete('Content-Security-Policy');
      return newResponse;
    }

    // 3. 画像・JS・その他のファイル：そのままバイナリとして安全にスルーして返す
    const newResponse = new Response(response.body, {
      status: response.status,
      statusText: response.statusText,
      headers: response.headers
    });

    newResponse.headers.set('Access-Control-Allow-Origin', '*');
    newResponse.headers.delete('X-Frame-Options');
    newResponse.headers.delete('Content-Security-Policy');

    return newResponse;

  } catch (e) {
    return new Response(`Proxy Error: ${e.message}`, { status: 500 });
  }
}
