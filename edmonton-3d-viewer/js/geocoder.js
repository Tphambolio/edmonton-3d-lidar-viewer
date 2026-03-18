/**
 * Address geocoding via ArcGIS World Geocoder — high accuracy for Edmonton.
 *
 * Free tier: 1M geocodes/month, no API key required for basic usage.
 * Falls back to Nominatim if ArcGIS fails.
 */
const Geocoder = {
    ARCGIS_URL: 'https://geocode.arcgis.com/arcgis/rest/services/World/GeocodeServer/findAddressCandidates',
    NOMINATIM_URL: 'https://nominatim.openstreetmap.org/search',

    async geocode(address) {
        let query = address;
        if (!query.toLowerCase().includes('edmonton')) {
            query += ', Edmonton, Alberta, Canada';
        } else if (!query.toLowerCase().includes('alberta') && !query.toLowerCase().includes(' ab')) {
            query += ', AB, Canada';
        }

        // Try ArcGIS first (much better Edmonton address accuracy)
        try {
            const result = await this._arcgisGeocode(query);
            if (result) return result;
        } catch (e) {
            console.warn('ArcGIS geocode failed, falling back to Nominatim:', e);
        }

        // Fallback to Nominatim
        return this._nominatimGeocode(query);
    },

    async _arcgisGeocode(query) {
        const params = new URLSearchParams({
            SingleLine: query,
            f: 'json',
            maxLocations: '1',
            outFields: 'Addr_type,City,Region',
            searchExtent: '-113.8,53.3,-113.2,53.7'   // Edmonton bounding box
        });

        const resp = await fetch(`${this.ARCGIS_URL}?${params}`);
        if (!resp.ok) return null;

        const data = await resp.json();
        if (!data.candidates || data.candidates.length === 0) return null;

        const c = data.candidates[0];
        if (c.score < 80) return null;  // reject low-confidence matches

        return {
            lat: c.location.y,
            lng: c.location.x,
            display: c.address
        };
    },

    async _nominatimGeocode(query) {
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

        if (!resp.ok) return null;

        const results = await resp.json();
        if (results.length === 0) return null;

        return {
            lat: parseFloat(results[0].lat),
            lng: parseFloat(results[0].lon),
            display: results[0].display_name.split(',').slice(0, 3).join(', ')
        };
    }
};
