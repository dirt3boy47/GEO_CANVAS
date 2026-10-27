# GeoCanvas Web — runs in Safari, no App Store, no Mac

The same idea as the native app (draw on a live map with Apple Pencil, ink pinned to real
coordinates), built as a website so it works on an iPad that can't be updated. Tuned for
**Toowoomba and the Darling Downs**: it opens on Toowoomba, uses Queensland Government aerial
imagery, and treats files without a coordinate system as **MGA zone 56** first.

Written for Safari on iPadOS 13 and newer (tested in a desktop Chromium engine, not yet on a real iPad). iOS 12 has a touch-event fallback for the Pencil that is untested. Nothing is installed from the App Store.

## Put it online (from the iPad, about 5 minutes, free)

You need somewhere to host the files. Cloudflare Pages is free and works from Safari:

1. Download **GeoCanvas-Web.zip** to the iPad (it will be in Files › Downloads). **Don't unzip it.**
2. In Safari go to **dash.cloudflare.com** and sign up (free; only an email is needed).
3. Open **Workers & Pages › Create application › Pages**, then choose to upload your files ("Drag and drop your files" / "Upload assets").
4. Name the project, e.g. `geocanvas-toowoomba`, then tap the upload area and pick **GeoCanvas-Web.zip** from Files. Tap **Deploy site**.
5. Cloudflare gives you an address like `https://geocanvas-toowoomba.pages.dev`. Open it in Safari.
6. Tap **Share › Add to Home Screen**. From now on GeoCanvas opens full screen, like an app, and works offline.

Other free hosts that take a ZIP or folder upload (e.g. Netlify) work the same way. The address must
be **https://**, because Safari only allows GPS on secure websites.

To update later: upload a new ZIP to the same Cloudflare project ("Create new deployment").

## Team & cloud (every project on every device)

- **Join:** tap ☁ in the top bar, type your name and the **team join code** (it looks like `ABCD-EFGH-JK23`;
  capitals, spaces and dashes don't matter). Anyone in the team finds the code under ☁ › Team join code
  (Copy / Share). No team yet? ☁ › **Start a team** makes the code. Never put the code in this public repository.
- **Every project is a team project.** Projects › one list of all team projects, on this iPad or not — tap one to
  open it. A new iPad that joins with nothing on it opens the team's latest project.
- **Saving is automatic:** changes go up about 2 s after you stop; other devices check every 15 s. The ☁ button
  shows the state (green dot = saved, blue = saving, orange = offline with changes waiting, red = problem) and the
  title line says “☁ In cloud”. Each iPad keeps a copy and works offline; it catches up when back online.
- **Two people on one project:** strokes, tracks, waypoints and photos from both are kept. If the same item or the
  same imported layer's settings change on two devices, the last device to save wins.
- **Removing access:** ☁ › New join code… The old code stops working; everyone rejoins with the new one (their
  projects are safe). 20 wrong codes from one connection lock it out for 10 minutes.
- **Deleting:** “Only from this iPad” (stays in the team cloud) or “For everyone”.

How it works: the site is a Cloudflare Worker (`worker/index.js`, config in `wrangler.jsonc`) that serves the app
and a small API at `/api/`. Data is stored in the Cloudflare D1 database `geocanvas` (schema in `migrations/`).
Pushing to the production branch redeploys automatically. The join code is stored only as a salted hash. If it is
forgotten: Cloudflare dashboard › Storage & Databases › D1 › geocanvas › Console › `DELETE FROM config;` — then the
next person to tap ☁ can **Start a team** with a new code. Projects are not affected.

## Using it

| | |
|---|---|
| **Navigate** mode | Drag and pinch to move the map. Tap a feature or drawing to see its details, length and area. |
| **Draw** mode | Apple Pencil draws; fingers still pan and zoom. Ballpoint, fountain pen, pencil, highlighter, marker, handwriting, eraser (whole object or precision), lasso (move, resize, recolour, duplicate, delete, move to layer), line, arrow, rectangle, ellipse, freehand polygon, text labels and symbol markers with notes. Tap the active tool again for thickness and opacity. Settings › "Draw with finger" if you don't have a Pencil. |
| Basemaps | QLD aerial imagery (default), QLD imagery + roads, Esri world imagery, OpenStreetMap, OpenTopoMap. If the Queensland service doesn't answer, GeoCanvas switches to Esri automatically. |
| Import (⤓) | KML, KMZ (incl. ground overlays), shapefiles (select .shp + .dbf + .shx + .prj together, or a ZIP), GeoJSON, GPX, GeoTIFF. GDA2020, GDA94, MGA zones 49–56, AMG, WGS84, Australian Albers and more are converted automatically. Files without a coordinate system are never guessed: you're asked (MGA 56 offered first). |
| Lot boundaries | Layers › “Lot boundaries (QLD cadastre)”: Queensland DCDB boundaries at every zoom; from zoom 16 lot/plan labels, tap a lot for its details (area, tenure…) and “Add to project” to keep it as a GIS layer. Search finds a lot by lot/plan (“3RP123456”, “Lot 3 on RP123456”). Measuring and plan placing snap to lot corners. Source: Land Parcel Property Framework, © State of Queensland, CC BY 4.0 (a guide, not a survey). |
| Plans (georeferencing) | Import (⤓) a PDF, PNG or JPG plan: the plan opens beside the map. Tap a point on the plan, then the same point on the map (lot corners snap); 2 points place it (position, scale, rotation), 3+ check the fit with an error per point (optional stretch/skew for scans). Saved as a layer with opacity and “Hide white paper”; ⋯ › Adjust georeferencing; synced; exported in KMZ as a rotated Google Earth overlay. |
| Photos | Add photos (camera, photo library or Files) to drawn markers, GPS waypoints and imported KMZ/GIS points or lines: in the marker editor, the details panel or the balloon. GPS › Photo waypoint drops a waypoint with a photo (at the GPS fix, else where the photo was taken). Photos are resized on the iPad (~2000 px), sync to other devices, are kept in backups, and are packed into KMZ exports so they show in Google Earth balloons. |
| Measure (ruler) | Line or Area. Tap points, or tick Freehand and trace a winding track, creek or boundary with the Pencil (fingers still move the map). Shows length, last segment and bearing, or area (ha and m²) and perimeter; drag points to adjust, Undo, and Save to map as a labelled line/area. Distances are on the GRS80 ellipsoid (GDA2020); areas use an equal-area projection. |
| GPS (➤) | Position, accuracy (good/fair/poor), MGA coordinates, altitude, speed, compass, follow-me, track recording, waypoints with notes. Warns when the iPad is Wi-Fi-only (no GPS chip) or the fix is poor/stale. |
| Export (⤒) | KML, KMZ, GeoJSON, GPX, transparent GeoTIFF, PNG + world file, print/PDF of the map, full project backup. Basemap imagery is never included. |
| Layers | Like Google Earth's Places panel: KML/KMZ folders open with ▸, every folder and placemark has its own eye (hiding a folder hides its contents), drag ⠿ to reorder layers. Tap a placemark in the list to fly to it. Also opacity, lock, rename, duplicate, delete, export, colours, labels, "Change coordinate system". |
| Placemark details | Tapping a feature opens a Google Earth style balloon: the KML description (HTML tables, links and photos inside the KMZ) or its BalloonStyle, the ExtendedData / shapefile attributes as a table, plus length/area and position. HTML from files is shown sandboxed (scripts never run). |
| Projects | Saved automatically on the iPad (IndexedDB). Several projects, rename/duplicate/delete, backup and restore. Optional cloud sync between devices (see above). |
| Offline | After the first visit the app works without internet. Settings › "Save this area for offline use" stores Queensland imagery for the area on screen. |

## Things to know

- **Back up.** Projects live in Safari's website storage on this iPad. Clearing Safari history and
  website data deletes them, and Safari may remove data of websites you haven't opened for weeks unless
  GeoCanvas is on the Home Screen. Use Project › Back up project (saves a `.geocanvas.json` to Files).
- **GPS tracks record only while GeoCanvas is open** with the screen on (Safari pauses location in the
  background). Recording asks the iPad to keep the screen awake where supported.
- Wi-Fi-only iPads have no GPS chip; positions come from Wi-Fi and can be hundreds of metres out.
- The map is always north-up (no rotation) — that keeps drawings exactly aligned.
- Exports: vectors are WGS84 longitude/latitude (what KML/GeoJSON/GPX require); rasters are Web
  Mercator (EPSG:3857). QGIS reprojects both to MGA 56 on the fly.

## Files

```
index.html, app.css          page and styles
js/geo.js                    coordinate systems (proj4 definitions incl. GDA94→GDA2020), formats
js/ink.js                    georeferenced ink engine (same model as the native GeoCanvasCore)
js/importers.js              KML/KMZ, shapefile/DBF, GeoJSON, GPX, GeoTIFF readers
js/exporters.js              KML, GeoJSON, GPX, GeoTIFF and world-file writers
js/store.js                  IndexedDB project storage
js/cloud.js                  cloud sync: three-way merge with the team's copy in Cloudflare D1
worker/index.js              Cloudflare Worker: serves the app and the /api/ sync endpoints
wrangler.jsonc, migrations/  Worker configuration and D1 database schema
js/app.js, draw.js, panels.js  map, layers, tools, Pencil input, GPS, import/export UI
sw.js, manifest.webmanifest  offline support and Home Screen app
vendor/                      Leaflet 1.9.4, proj4 2.11.0, JSZip 3.10.1, togeojson 5.8.1, geotiff.js 2.1.3, pdf.js 2.16 (legacy build, Apache-2.0)
```

To try it on a computer: `python3 -m http.server` in this folder, then open http://localhost:8000.
