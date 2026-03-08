/**
 * Address geocoding via Nominatim (OSM) — free, CORS-friendly.
 *
 * Note: Edmonton has a geocoder at gis.edmonton.ca but it blocks CORS
 * from non-edmonton origins. Use it server-side if needed.
 */
const Geocoder = {
    NOMINATIM_URL: 'https://nominatim.openstreetmap.org/search',

    async geocode(address) {
        let query = address;
        if (!query.toLowerCase().includes('edmonton')) {
            query += ', Edmonton, Alberta, Canada';
        }

        const params = new URLSearchParams({
            q: query,
            format: 'json',
            limit: '1',
            countrycodes: 'ca',
            viewbox: '-113.8,53.3,-113.2,53.7',
            bounded: '1'
        });

        const resp = await fetch(`${this.NOMINATIM_URL}?${params}`, {
            headers: { 'User-Agent': 'Edmonton3DTreeViewer/1.0' }
        });

        if (!resp.ok) throw new Error(`Geocoding failed: ${resp.status}`);

        const results = await resp.json();
        if (results.length === 0) return null;

        return {
            lat: parseFloat(results[0].lat),
            lng: parseFloat(results[0].lon),
            display: results[0].display_name.split(',').slice(0, 3).join(', ')
        };
    }
};
