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
    // リダイレクトを手動制御してGASなどのジャンプ先をプロキシ内に確実に繋ぎ止める
    const fetchReq = new Request(targetUrl.toString(), {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
        'Accept': request.headers.get('Accept') || '*/*',
        'Accept-Language': 'ja,en-US;q=0.9,en;q=0.8',
        'Referer': targetUrl.origin,
        'Cookie': request.headers.get('Cookie') || ''
      },
      method: request.method,
      redirect: 'manual' 
    });

    const response = await fetch(fetchReq);

    // GASやログイン等で発生するリダイレクト (301, 302, 303, 307, 308) をキャッチしてプロキシURLに変換
    if ([301, 302, 303, 307, 308].includes(response.status)) {
      const location = response.headers.get('Location');
      if (location) {
        let absoluteRedirectUrl;
        if (location.startsWith('http://') || location.startsWith('https://')) {
          absoluteRedirectUrl = location;
        } else if (location.startsWith('//')) {
          absoluteRedirectUrl = targetUrl.protocol + location;
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

    // 1. HTMLの場合のリンク自動書き換え (GASのWebアプリ画面内リンク等に対応)
    if (contentType.includes('text/html')) {
      let html = await response.text();

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

      // GASアプリ内の動的クリックもプロキシを通すパッチ
      const injectionScript = `
        <script>
          document.addEventListener('click', function(e) {
            const anchor = e.target.closest('a');
            if (anchor && anchor.href) {
              try {
                const u = new URL(anchor.href);
                if (u.origin === "${origin}" || u.hostname.endsWith('script.google.com') || u.hostname.endsWith('googleusercontent.com')) {
                  e.preventDefault();
                  window.location.href = "${proxyBase}" + encodeURIComponent(anchor.href);
                }
              } catch(err) {}
            }
          }, true);
        </script>
      `;

      if (html.includes('</body>')) {
        html = html.replace('</body>', injectionScript + '</body>');
      } else {
        html += injectionScript;
      }

      const newResponse = new Response(html, response);
      newResponse.headers.set('Access-Control-Allow-Origin', '*');
      newResponse.headers.delete('X-Frame-Options');
      newResponse.headers.delete('Content-Security-Policy');
      return newResponse;
    }

    // 2. CSSの書き換え
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

    // 3. その他（JS、画像など）
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
