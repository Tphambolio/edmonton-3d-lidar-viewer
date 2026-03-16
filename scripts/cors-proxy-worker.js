const UPSTREAM = "https://gis.edmonton.ca/site1/rest/services/Overlay_Public/Common_Layers/MapServer";

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
};

export default {
  async fetch(request) {
    const url = new URL(request.url);

    // Only handle /mapserver/* paths
    if (!url.pathname.startsWith("/mapserver")) {
      return new Response("Not Found", { status: 404 });
    }

    // Handle CORS preflight
    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: CORS_HEADERS });
    }

    // Only allow GET requests
    if (request.method !== "GET") {
      return new Response("Method Not Allowed", { status: 405, headers: CORS_HEADERS });
    }

    // Strip /mapserver prefix and build upstream URL
    const path = url.pathname.replace(/^\/mapserver\/?/, "/");
    const upstream = UPSTREAM + (path === "/" ? "" : path) + url.search;

    const response = await fetch(upstream, {
      method: "GET",
      headers: {
        "User-Agent": request.headers.get("User-Agent") || "",
        "Accept": request.headers.get("Accept") || "*/*",
      },
    });

    // Clone response and add CORS headers
    const newHeaders = new Headers(response.headers);
    for (const [key, value] of Object.entries(CORS_HEADERS)) {
      newHeaders.set(key, value);
    }

    return new Response(response.body, {
      status: response.status,
      statusText: response.statusText,
      headers: newHeaders,
    });
  },
};
