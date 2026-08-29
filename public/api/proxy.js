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

    const fetchOptions = {
      headers: headers,
      method: request.method,
      redirect: 'manual'
    };

    if (request.method !== 'GET' && request.method !== 'HEAD') {
      fetchOptions.body = request.body;
      fetchOptions.duplex = 'half';
    }

    const fetchReq = new Request(targetUrl.toString(), fetchOptions);
    const response = await fetch(fetchReq);

    // リダイレクト処理
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

    // 1. HTMLの場合：ゲーム用パッチ ＋ Baseタグ ＋ アセット書き換え
    if (contentType.includes('text/html')) {
      let html = await response.text();

      const gameEnginePatch = `
        <script>
          (function() {
            const proxyBase = '/api/proxy?url=';
            const targetOrigin = "${origin}";
            const targetPath = "${targetUrl.pathname}";

            function resolveUrl(u) {
              if (!u) return u;
              if (typeof u !== 'string') return u;
              if (u.startsWith(proxyBase) || u.startsWith('data:') || u.startsWith('blob:') || u.startsWith('javascript:')) {
                return u;
              }
              let absolute = u;
              if (u.startsWith('//')) {
                absolute = window.location.protocol + u;
              } else if (u.startsWith('/')) {
                absolute = targetOrigin + u;
              } else if (!u.startsWith('http://') && !u.startsWith('https://')) {
                const baseDir = targetPath.substring(0, targetPath.lastIndexOf('/') + 1);
                absolute = targetOrigin + baseDir + u;
              }
              return proxyBase + encodeURIComponent(absolute);
            }

            // fetchのオーバーライド
            const origFetch = window.fetch;
            window.fetch = function(resource, init) {
              let url = resource;
              if (typeof resource === 'string') {
                url = resolveUrl(resource);
              } else if (resource instanceof Request) {
                const newReqUrl = resolveUrl(resource.url);
                resource = new Request(newReqUrl, init);
              }
              return origFetch(resource, init);
            };

            // XHRのオーバーライド
            const origOpen = XMLHttpRequest.prototype.open;
            XMLHttpRequest.prototype.open = function(method, url, async, user, password) {
              if (typeof url === 'string') {
                url = resolveUrl(url);
              }
              return origOpen.call(this, method, url, async, user, password);
            };

            // 動的要素生成の属性書き換え
            const origSetAttribute = Element.prototype.setAttribute;
            Element.prototype.setAttribute = function(name, value) {
              if ((name === 'src' || name === 'href' || name === 'action') && typeof value === 'string') {
                value = resolveUrl(value);
              }
              return origSetAttribute.call(this, name, value);
            };

            // 画像読み込みのフック
            const OrigImage = window.Image;
            window.Image = function(width, height) {
              const img = new OrigImage(width, height);
              const origImgSrcDesc = Object.getOwnPropertyDescriptor(HTMLImageElement.prototype, 'src');
              Object.defineProperty(img, 'src', {
                set(val) { origImgSrcDesc.set.call(this, resolveUrl(val)); },
                get() { return origImgSrcDesc.get.call(this); }
              });
              return img;
            };

            // ゲームにフォーカスを自動であててキー入力を有効にする
            window.addEventListener('DOMContentLoaded', () => {
              window.focus();
              document.body.click();
            });
          })();
        </script>
        <base href="${proxyBase}${encodeURIComponent(origin + targetUrl.pathname)}">
      `;

      html = html.replace(/(href|src|action|formaction)=["'](\/[^"']*)["']/gi, (match, attr, path) => {
        if (path.startsWith('//')) {
          return `${attr}="${proxyBase}${encodeURIComponent(targetUrl.protocol + path)}"`;
        }
        return `${attr}="${proxyBase}${encodeURIComponent(origin + path)}"`;
      });

      html = html.replace(/(href|src|action)=["'](https?:\/\/[^"']+)["']/gi, (match, attr, fullUrl) => {
        if (fullUrl.startsWith(origin) || fullUrl.includes('bravetyping.net') || fullUrl.includes('typingerz.com')) {
          return `${attr}="${proxyBase}${encodeURIComponent(fullUrl)}"`;
        }
        return match;
      });

      if (html.includes('<head>')) {
        html = html.replace('<head>', '<head>' + gameEnginePatch);
      } else {
        html = gameEnginePatch + html;
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
