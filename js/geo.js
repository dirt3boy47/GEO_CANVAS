/* GeoCanvas web — geodesy, Web Mercator, coordinate reference systems.
   Written as plain ES2017 (no modules, no optional chaining) so it runs on older iPad Safari. */
(function (global) {
  'use strict';
  var D2R = Math.PI / 180;

  // Web Mercator "world" units 0..1 (x east, y south). One unit = 256·2^z pixels at zoom z.
  function merc(lon, lat) {
    var la = Math.max(-85.05112878, Math.min(85.05112878, lat));
    var s = Math.sin(la * D2R);
    return [(lon + 180) / 360, 0.5 - Math.log((1 + s) / (1 - s)) / (4 * Math.PI)];
  }
  function unmerc(x, y) {
    var n = Math.PI - 2 * Math.PI * y;
    return [x * 360 - 180, Math.atan(Math.sinh(n)) / D2R];
  }
  function to3857(m) { var C = 40075016.685578488; return [(m[0] - 0.5) * C, (0.5 - m[1]) * C]; }

  // Ground metres per screen pixel at a zoom/latitude.
  function metersPerPixel(zoom, lat) { return 40075016.685578488 * Math.cos(lat * D2R) / (256 * Math.pow(2, zoom)); }

  function haversine(a, b) {
    var R = 6371008.8, dLat = (b[1] - a[1]) * D2R, dLon = (b[0] - a[0]) * D2R;
    var h = Math.sin(dLat / 2) * Math.sin(dLat / 2) + Math.cos(a[1] * D2R) * Math.cos(b[1] * D2R) * Math.sin(dLon / 2) * Math.sin(dLon / 2);
    return 2 * R * Math.asin(Math.min(1, Math.sqrt(h)));
  }
  /** Distance on the GRS80 ellipsoid (GDA2020/WGS84), Vincenty's inverse formula; mm-accurate. */
  function geodesic(a, b) {
    var A = 6378137, F = 1 / 298.257222101, B = A * (1 - F);
    var L = (b[0] - a[0]) * D2R, U1 = Math.atan((1 - F) * Math.tan(a[1] * D2R)), U2 = Math.atan((1 - F) * Math.tan(b[1] * D2R));
    var sU1 = Math.sin(U1), cU1 = Math.cos(U1), sU2 = Math.sin(U2), cU2 = Math.cos(U2), lam = L, prev, sS, cS, sig, ca2, c2m, it = 0;
    do {
      var sl = Math.sin(lam), cl = Math.cos(lam);
      sS = Math.sqrt((cU2 * sl) * (cU2 * sl) + (cU1 * sU2 - sU1 * cU2 * cl) * (cU1 * sU2 - sU1 * cU2 * cl));
      if (sS === 0) return 0;
      cS = sU1 * sU2 + cU1 * cU2 * cl; sig = Math.atan2(sS, cS);
      var sa = cU1 * cU2 * sl / sS; ca2 = 1 - sa * sa;
      c2m = ca2 ? cS - 2 * sU1 * sU2 / ca2 : 0;
      var C = F / 16 * ca2 * (4 + F * (4 - 3 * ca2));
      prev = lam; lam = L + (1 - C) * F * sa * (sig + C * sS * (c2m + C * cS * (-1 + 2 * c2m * c2m)));
    } while (Math.abs(lam - prev) > 1e-12 && ++it < 200);
    if (it >= 200) return haversine(a, b); // near-antipodal: not needed here
    var u2 = ca2 * (A * A - B * B) / (B * B), K = 1 + u2 / 16384 * (4096 + u2 * (-768 + u2 * (320 - 175 * u2))), K2 = u2 / 1024 * (256 + u2 * (-128 + u2 * (74 - 47 * u2)));
    var dS = K2 * sS * (c2m + K2 / 4 * (cS * (-1 + 2 * c2m * c2m) - K2 / 6 * c2m * (-3 + 4 * sS * sS) * (-3 + 4 * c2m * c2m)));
    return B * K * (sig - dS);
  }
  function pathLength(coords) { var s = 0; for (var i = 1; i < coords.length; i++) s += geodesic(coords[i - 1], coords[i]); return s; }
  /** Area in m² on the GRS80 ellipsoid: the ring is projected to an equal-area (LAEA) plane centred on it. */
  function ringArea(ring) {
    if (ring.length < 3) return 0;
    var t = 0, i, p, q;
    if (global.proj4) {
      var lon = 0, lat = 0; ring.forEach(function (c) { lon += c[0]; lat += c[1]; }); lon /= ring.length; lat /= ring.length;
      try {
        var pr = proj4('+proj=laea +lat_0=' + lat + ' +lon_0=' + lon + ' +ellps=GRS80 +units=m +no_defs'), xy = ring.map(function (c) { return pr.forward([c[0], c[1]]); });
        for (i = 0; i < xy.length; i++) { p = xy[i]; q = xy[(i + 1) % xy.length]; t += p[0] * q[1] - q[0] * p[1]; }
        if (isFinite(t)) return Math.abs(t / 2);
      } catch (e) { /* fall back to the sphere */ }
      t = 0;
    }
    var R = 6371008.8;
    for (i = 0; i < ring.length; i++) { p = ring[i]; q = ring[(i + 1) % ring.length]; t += (q[0] - p[0]) * D2R * (2 + Math.sin(p[1] * D2R) + Math.sin(q[1] * D2R)); }
    return Math.abs(t * R * R / 2);
  }
  /** Initial true bearing from a to b, degrees 0–360. */
  function bearing(a, b) {
    var y = Math.sin((b[0] - a[0]) * D2R) * Math.cos(b[1] * D2R), x = Math.cos(a[1] * D2R) * Math.sin(b[1] * D2R) - Math.sin(a[1] * D2R) * Math.cos(b[1] * D2R) * Math.cos((b[0] - a[0]) * D2R);
    return (Math.atan2(y, x) / D2R + 360) % 360;
  }

  // ---------- Coordinate reference systems (proj4 definitions) ----------
  // GDA94→GDA2020 (ICSM, EPSG:8048) expressed in proj4's position-vector convention; WGS84 ≈ GDA2020.
  var GDA94_TOWGS = '+towgs84=0.06155,-0.01087,-0.04019,0.0394924,0.0327221,0.0328979,-0.009994';
  var AGD66_TOWGS = '+towgs84=-117.808,-51.536,137.784,0.303,0.446,0.234,-0.29';
  var AGD84_TOWGS = '+towgs84=-117.763,-51.51,139.061,0.292,0.443,0.277,-0.191';
  var CRS = {};
  function add(code, name, def) { CRS[code] = { code: code, name: name, def: def }; if (global.proj4) proj4.defs('EPSG:' + code, def); }
  function init() {
    add(4326, 'WGS 84 (lat/lon)', '+proj=longlat +datum=WGS84 +no_defs');
    add(7844, 'GDA2020 (lat/lon)', '+proj=longlat +ellps=GRS80 +towgs84=0,0,0,0,0,0,0 +no_defs');
    add(4283, 'GDA94 (lat/lon)', '+proj=longlat +ellps=GRS80 ' + GDA94_TOWGS + ' +no_defs');
    add(4202, 'AGD66 (lat/lon)', '+proj=longlat +ellps=aust_SA ' + AGD66_TOWGS + ' +no_defs');
    add(4203, 'AGD84 (lat/lon)', '+proj=longlat +ellps=aust_SA ' + AGD84_TOWGS + ' +no_defs');
    add(3857, 'Web Mercator', '+proj=merc +a=6378137 +b=6378137 +lat_ts=0 +lon_0=0 +x_0=0 +y_0=0 +k=1 +units=m +nadgrids=@null +no_defs');
    for (var z = 46; z <= 59; z++) {
      add(7800 + z, 'GDA2020 / MGA zone ' + z, '+proj=utm +zone=' + z + ' +south +ellps=GRS80 +towgs84=0,0,0,0,0,0,0 +units=m +no_defs');
      if (z >= 48 && z <= 58) {
        add(28300 + z, 'GDA94 / MGA zone ' + z, '+proj=utm +zone=' + z + ' +south +ellps=GRS80 ' + GDA94_TOWGS + ' +units=m +no_defs');
        add(20200 + z, 'AGD66 / AMG zone ' + z, '+proj=utm +zone=' + z + ' +south +ellps=aust_SA ' + AGD66_TOWGS + ' +units=m +no_defs');
        add(20300 + z, 'AGD84 / AMG zone ' + z, '+proj=utm +zone=' + z + ' +south +ellps=aust_SA ' + AGD84_TOWGS + ' +units=m +no_defs');
      }
    }
    for (var u = 1; u <= 60; u++) {
      add(32700 + u, 'WGS 84 / UTM zone ' + u + 'S', '+proj=utm +zone=' + u + ' +south +datum=WGS84 +units=m +no_defs');
      add(32600 + u, 'WGS 84 / UTM zone ' + u + 'N', '+proj=utm +zone=' + u + ' +datum=WGS84 +units=m +no_defs');
    }
    var alb = '+proj=aea +lat_0=0 +lon_0=132 +lat_1=-18 +lat_2=-36 +x_0=0 +y_0=0 +ellps=GRS80 +units=m +no_defs';
    add(3577, 'GDA94 / Australian Albers', alb + ' ' + GDA94_TOWGS);
    add(9473, 'GDA2020 / Australian Albers', alb + ' +towgs84=0,0,0,0,0,0,0');
    var ga = '+proj=lcc +lat_0=0 +lon_0=134 +lat_1=-18 +lat_2=-36 +x_0=0 +y_0=0 +ellps=GRS80 +units=m +no_defs';
    add(3112, 'GDA94 / Geoscience Australia Lambert', ga + ' ' + GDA94_TOWGS);
    add(7845, 'GDA2020 / GA LCC', ga + ' +towgs84=0,0,0,0,0,0,0');
  }

  function crsLabel(code) { return CRS[code] ? CRS[code].name + ' (EPSG:' + code + ')' : 'EPSG:' + code; }

  // Converts [x, y] in a CRS to [lon, lat] WGS84.
  function toWGS84(code, xy) {
    if (code === 4326 || code === 7844) return [xy[0], xy[1]];
    return proj4('EPSG:' + code, 'EPSG:4326', [xy[0], xy[1]]);
  }
  function fromWGS84(code, ll) { return proj4('EPSG:4326', 'EPSG:' + code, [ll[0], ll[1]]); }

  // Identifies a .prj (ESRI or OGC WKT). Returns {code, warning} or {def, name, warning} or null.
  function parsePrj(text) {
    if (!text) return null;
    var t = String(text).trim();
    var auth = /AUTHORITY\["EPSG",\s*"?(\d+)"?\]\s*\]\s*$/i.exec(t) || /ID\["EPSG",\s*(\d+)\]\s*\]\s*$/i.exec(t);
    if (auth && CRS[+auth[1]]) return { code: +auth[1] };
    var N = t.toUpperCase().replace(/\s/g, '_');
    var name = (/^\w+\["([^"]+)"/.exec(t) || [])[1] || '';
    var nm = name.toUpperCase().replace(/[\s\/]+/g, '_');
    var zm = /ZONE_?(\d{1,2})/.exec(nm);
    var zone = zm ? +zm[1] : null;
    var datum2020 = /GDA_?2020|GEOCENTRIC_DATUM_OF_AUSTRALIA_2020/.test(N);
    var datum94 = !datum2020 && /GDA_?1994|GDA94|GEOCENTRIC_DATUM_OF_AUSTRALIA_1994|D_GDA_1994/.test(N);
    var agd84 = /AGD84|AUSTRALIAN_1984|AUSTRALIAN_GEODETIC_DATUM_1984/.test(N);
    var agd66 = /AGD66|AUSTRALIAN_1966|AUSTRALIAN_GEODETIC_DATUM_1966/.test(N);
    var isProj = /^PROJ/i.test(t);
    if (isProj) {
      var cm = /CENTRAL_MERIDIAN",\s*([-\d.]+)/i.exec(t) || /LONGITUDE OF NATURAL ORIGIN",\s*([-\d.]+)/i.exec(t);
      var fn = /FALSE_NORTHING",\s*([-\d.]+)/i.exec(t);
      var k = /SCALE_FACTOR",\s*([-\d.]+)/i.exec(t);
      var tm = /TRANSVERSE_MERCATOR/i.test(t);
      if (!zone && tm && cm && k && Math.abs(+k[1] - 0.9996) < 1e-9) { var zz = Math.round((+cm[1] + 183) / 6); if (Math.abs(zz * 6 - 183 - +cm[1]) < 1e-9) zone = zz; }
      var south = !fn || +fn[1] === 10000000;
      if (zone && tm || /MGA|AMG|UTM/.test(nm)) {
        if (datum2020 && CRS[7800 + zone]) return { code: 7800 + zone };
        if (datum94 && CRS[28300 + zone]) return { code: 28300 + zone };
        if (agd84 && CRS[20300 + zone]) return { code: 20300 + zone };
        if (agd66 && CRS[20200 + zone]) return { code: 20200 + zone };
        if (/WGS/.test(N) && zone) return { code: (south ? 32700 : 32600) + zone };
      }
      if (/MERCATOR_AUXILIARY|PSEUDO.?MERCATOR/.test(N)) return { code: 3857 };
      if (/ALBERS/.test(N) && /132/.test(t)) return { code: datum2020 ? 9473 : 3577 };
    } else if (/^GEOG/i.test(t)) {
      if (datum2020) return { code: 7844 };
      if (datum94) return { code: 4283 };
      if (agd84) return { code: 4203 };
      if (agd66) return { code: 4202 };
      if (/WGS_?1984|WGS84|WGS_84/.test(N)) return { code: 4326 };
    }
    // Generic: let proj4 interpret the WKT.
    try {
      proj4(t, 'EPSG:4326', [0, 0]);
      var def = 'WKT:' + name;
      proj4.defs(def, t);
      CRS[def] = { code: def, name: name || 'Custom CRS', def: t };
      return { code: def, warning: (datum94 || datum2020 || /WGS/.test(N)) ? null : 'The datum in the .prj file is not recognised; it was treated as WGS84, which can shift positions by tens of metres.' };
    } catch (e) { return null; }
  }

  // CRS options offered when a file has no CRS (Toowoomba is in MGA zone 56).
  function pickerOptions(hintZone) {
    var zones = [56, 55, 54, 53, 52, 51, 50, 49];
    if (hintZone && zones.indexOf(hintZone) > 0) { zones.splice(zones.indexOf(hintZone), 1); zones.unshift(hintZone); }
    var out = [];
    zones.forEach(function (z) { out.push(7800 + z); out.push(28300 + z); });
    out.push(4326, 7844, 4283, 3577, 9473, 3857);
    zones.slice(0, 3).forEach(function (z) { out.push(20300 + z); out.push(20200 + z); });
    return out;
  }

  function utmZone(lon) { return Math.max(1, Math.min(60, Math.floor((lon + 180) / 6) + 1)); }

  function fmt(ll, mode) {
    var lon = ll[0], lat = ll[1];
    function dms(v, p, n) { var a = Math.abs(v), d = Math.floor(a), mf = (a - d) * 60, m = Math.floor(mf), s = (mf - m) * 60; if (s >= 59.995) { s = 0; m++; } if (m >= 60) { m = 0; d++; } return d + '°' + (m < 10 ? '0' : '') + m + '′' + (s < 10 ? '0' : '') + s.toFixed(2) + '″' + (v < 0 ? n : p); }
    if (mode === 'dms') return dms(lat, 'N', 'S') + '  ' + dms(lon, 'E', 'W');
    if (mode === 'mga') {
      var z = utmZone(lon), p = fromWGS84(7800 + z, ll);
      return 'MGA' + z + '  ' + p[0].toFixed(0) + 'E  ' + p[1].toFixed(0) + 'N';
    }
    return lat.toFixed(6) + ', ' + lon.toFixed(6);
  }

  // Parses "-27.56, 151.95", DMS with N/S/E/W, or "56 396000 6951000" / "MGA56 396000E 6951000N".
  function parseCoordinate(text) {
    var s = String(text || '').trim().toUpperCase();
    if (!s) return null;
    var nums = (s.replace(/(\d)-/g, '$1 ').match(/-?\d+(\.\d+)?/g) || []).map(Number);
    if (nums.length === 3 && /^\d{1,2}$/.test(String(nums[0])) && nums[1] > 100000 && nums[1] < 1000000 && nums[2] > 1000000) {
      var z = nums[0]; if (z < 1 || z > 60) return null;
      var code = /UTM/.test(s) ? 32700 + z : 7800 + z;
      var ll = toWGS84(code, [nums[1], nums[2]]);
      return isFinite(ll[0]) ? ll : null;
    }
    if (/[NSEW]/.test(s)) {
      var vals = [], cur = [];
      var re = /(-?\d+(?:\.\d+)?)|([NSEW])/g, m;
      while ((m = re.exec(s))) { if (m[1]) cur.push(+m[1]); else { vals.push({ v: cur, h: m[2] }); cur = []; } }
      if (vals.length !== 2) return null;
      function dec(o) { var v = o.v[0] + (o.v[1] || 0) / 60 + (o.v[2] || 0) / 3600; return (o.h === 'S' || o.h === 'W') ? -v : v; }
      var a = vals[0], b = vals[1], lat, lon;
      if (/[NS]/.test(a.h) && /[EW]/.test(b.h)) { lat = dec(a); lon = dec(b); } else if (/[EW]/.test(a.h) && /[NS]/.test(b.h)) { lat = dec(b); lon = dec(a); } else return null;
      return [lon, lat];
    }
    if (nums.length === 2 && Math.abs(nums[0]) <= 90 && Math.abs(nums[1]) <= 180) return [nums[1], nums[0]];
    return null;
  }

  global.Geo = { merc: merc, unmerc: unmerc, to3857: to3857, metersPerPixel: metersPerPixel, haversine: haversine, geodesic: geodesic, bearing: bearing, pathLength: pathLength,
    ringArea: ringArea, CRS: CRS, init: init, crsLabel: crsLabel, toWGS84: toWGS84, fromWGS84: fromWGS84, parsePrj: parsePrj,
    pickerOptions: pickerOptions, utmZone: utmZone, fmt: fmt, parseCoordinate: parseCoordinate };
})(typeof window !== 'undefined' ? window : global);
