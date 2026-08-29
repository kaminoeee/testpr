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
    // リクエストヘッダーの構築
    const headers = {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
      'Accept': request.headers.get('Accept') || '*/*',
      'Accept-Language': 'ja,en-US;q=0.9,en;q=0.8',
      'Referer': targetUrl.origin,
      'Cookie': request.headers.get('Cookie') || ''
    };

    const contentTypeHeader = request.headers.get('content-type');
    if (contentTypeHeader) {
      headers['Content-Type'] = contentTypeHeader;
    }

    // POSTやPUTなどのボディ（送信データ）を転送する設定
    const fetchOptions = {
      headers: headers,
      method: request.method,
      redirect: 'manual'
    };

    if (request.method !== 'GET' && request.method !== 'HEAD') {
      fetchOptions.body = request.body;
      fetchOptions.duplex = 'half'; // Vercel Edge RuntimeでのストリーミングPOSTに必須
    }

    const fetchReq = new Request(targetUrl.toString(), fetchOptions);
    const response = await fetch(fetchReq);

    // リダイレクト処理 (301, 302など)
    if ([301, 302, 303, 307, 308].includes(response.status)) {
      const location = response.headers.get('Location');
      if (location) {
        let absoluteRedirectUrl;
        if (location.startsWith('http://') || location.startsWith('https://')) {
          absoluteRedirectUrl = location;
        } else if (location.startsWith('//')) {
          absoluteRedirectUrl = targetUrl.protocol + location;
        } else if (location.startsWith('/')) {
          absoluteRedirectUrl = `${targetUrl.protocol}//${targetUrl.host}${location}`;
        } else {
          const basePath = targetUrl.pathname.substring(0, targetUrl.pathname.lastIndexOf('/') + 1);
          absoluteRedirectUrl = `${targetUrl.protocol}//${targetUrl.host}${basePath}${location}`;
        }

        const proxyRedirectUrl = `/api/proxy?url=${encodeURIComponent(absoluteRedirectUrl)}`;
        return new Response(null, {
          status: response.status,
          headers: {
            'Location': proxyRedirectUrl,
            'Access-Control-Allow-Origin': '*'
          }
        });
      }
    }

    const contentType = response.headers.get('content-type') || '';
    const origin = `${targetUrl.protocol}//${targetUrl.host}`;
    const proxyBase = `/api/proxy?url=`;

    if (contentType.includes('text/html')) {
      let html = await response.text();

      // パス書き換え
      html = html.replace(/(href|src|action|formaction)=["'](\/[^"']*)["']/gi, (match, attr, path) => {
        if (path.startsWith('//')) {
          return `${attr}="${proxyBase}${encodeURIComponent(targetUrl.protocol + path)}"`;
        }
        return `${attr}="${proxyBase}${encodeURIComponent(origin + path)}"`;
      });

      html = html.replace(/(href|src|action)=["'](https?:\/\/[^"']+)["']/gi, (match, attr, fullUrl) => {
        if (fullUrl.startsWith(origin) || fullUrl.includes('script.google.com') || fullUrl.includes('googleusercontent.com')) {
          return `${attr}="${proxyBase}${encodeURIComponent(fullUrl)}"`;
        }
        return match;
      });

      // JSからのfetch / XHR をすべてプロキシ経由にするパッチ
      const patchScript = `
        <script>
          (function() {
            const proxyBase = '/api/proxy?url=';
            const targetOrigin = "${origin}";

            const originalFetch = window.fetch;
            window.fetch = function(resource, init) {
              let url = resource;
              if (typeof resource === 'string') {
                if (url.startsWith('/')) {
                  url = targetOrigin + url;
                } else if (!url.startsWith('http://') && !url.startsWith('https://') && !url.startsWith(proxyBase)) {
                  url = targetOrigin + '/' + url;
                }
                if ((url.startsWith('http://') || url.startsWith('https://')) && !url.includes(proxyBase)) {
                  url = proxyBase + encodeURIComponent(url);
                }
              }
              return originalFetch(url, init);
            };

            const originalOpen = XMLHttpRequest.prototype.open;
            XMLHttpRequest.prototype.open = function(method, url, async, user, password) {
              let targetUrl = url;
              if (typeof targetUrl === 'string') {
                if (targetUrl.startsWith('/')) {
                  targetUrl = targetOrigin + targetUrl;
                } else if (!targetUrl.startsWith('http://') && !targetUrl.startsWith('https://') && !targetUrl.includes(proxyBase)) {
                  targetUrl = targetOrigin + '/' + targetUrl;
                }
                if ((targetUrl.startsWith('http://') || targetUrl.startsWith('https://')) && !targetUrl.includes(proxyBase)) {
                  targetUrl = proxyBase + encodeURIComponent(targetUrl);
                }
              }
              return originalOpen.call(this, method, targetUrl, async, user, password);
            };
          })();
        </script>
      `;

      if (html.includes('<head>')) {
        html = html.replace('<head>', '<head>' + patchScript);
      } else {
        html = patchScript + html;
      }

      const newResponse = new Response(html, response);
      newResponse.headers.set('Access-Control-Allow-Origin', '*');
      newResponse.headers.delete('X-Frame-Options');
      newResponse.headers.delete('Content-Security-Policy');
      return newResponse;
    }

    // CSSの書き換え
    if (contentType.includes('text/css')) {
      let css = await response.text();
      css = css.replace(/url\(\s*["']?([^"')]+)["']?\s*\)/gi, (match, assetPath) => {
        let absoluteUrl = assetPath;
        if (assetPath.startsWith('http://') || assetPath.startsWith('https://')) {
          absoluteUrl = assetPath;
        } else if (assetPath.startsWith('/')) {
          absoluteUrl = origin + assetPath;
        } else {
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
