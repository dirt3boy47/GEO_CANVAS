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

- **Create a team:** tap ☁ in the top bar › **Create a team**, type your name and a team name (e.g. a job or crew).
  GeoCanvas makes the team's join code. There can be any number of teams; each has its own projects.
- **Join a team:** ☁ › **Join a team**, type your name and the team's **join code** (it looks like
  `ABCD-EFGH-JK23`; capitals, spaces and dashes don't matter). Anyone in a team finds its code under ☁ › Team join
  code (Copy / Share). Never put a join code in this public repository.
- **Switch team:** ☁ › Leave / switch team, then join or create another. Projects of the old team stay on the iPad
  (labelled in Projects) but are never uploaded into the new team.
- **Every project is a team project.** Projects › one list of all team projects, on this iPad or not — tap one to
  open it. A new iPad that joins with nothing on it opens the team's latest project.
- **Saving is automatic:** changes go up about 2 s after you stop; other devices check every 15 s. The ☁ button
  shows the state (green dot = saved, blue = saving, orange = offline with changes waiting, red = problem) and the
  title line says “☁ In cloud”. Each iPad keeps a copy and works offline; it catches up when back online.
- **Two people on one project:** strokes, tracks, waypoints and photos from both are kept. If the same item or the
  same imported layer's settings change on two devices, the last device to save wins.
- **Removing access:** ☁ › New join code… The old code stops working; everyone rejoins with the new one (their
  projects are safe). 20 wrong codes from one connection lock it out for 10 minutes; one connection can create at
  most 10 teams per 10 minutes.
- **Deleting:** “Only from this iPad” (stays in the team cloud) or “For everyone”.

How it works: the site is a Cloudflare Worker (`worker/index.js`, config in `wrangler.jsonc`) that serves the app
and a small API at `/api/`. Data is stored in the Cloudflare D1 database `geocanvas` (schema in `migrations/`).
Pushing to the production branch redeploys automatically. Teams are in the `teams` table; join codes are stored
only as SHA-256 fingerprints. If every member of a team forgets its code, make a new team (☁ › Create a team);
the old team's projects are still on the iPads that had them.

## Using it

| | |
|---|---|
| **Navigate** mode | Drag and pinch to move the map. Tap anything (a pipe, valve, lot, drawing, waypoint or photo point) for its card. |
| Tap cards | Every card looks the same and has the same buttons: **Go** (guide me there), **Measure** (measure from here), **Photo** and **Note** (kept on the feature, drawing or waypoint; on a lot or map service they pin a waypoint at the tap), **Copy** (lat/long or MGA2020 to the clipboard) and **More** (Zoom to, Hide, Rename, Delete, Add lot to project…). |
| Go (take me there) | From a card or a search result. A dashed line runs from your blue GPS dot to the nearest point of the feature (a line or area is reached at its closest edge), with a live readout such as “142 m · Bearing 63° ENE · ahead-left” (turns use the iPad compass, or your direction of travel when walking). Within 5 m it says “You’re there” and the iPad buzzes where supported. Show both fits you and the target; Stop ends it. |
| Search | Finds your own data first as you type: feature names, attributes and folder names (“PHW-AV-002”, “thrust block 13”), drawn markers and text, waypoints and tracks, each with a Go button. Then places, coordinates (lat/long or MGA) and lot/plan. |
| **Draw** mode | Apple Pencil draws; fingers still pan and zoom. Ballpoint, fountain pen, pencil, highlighter, marker, handwriting, eraser (whole object or precision), lasso (move, resize, recolour, duplicate, delete, move to layer), line, arrow, rectangle, ellipse, freehand polygon, text labels and symbol markers with notes. Tap the active tool again for thickness and opacity. Settings › "Draw with finger" if you don't have a Pencil. |
| Basemaps | QLD aerial imagery (default), QLD imagery + roads, Esri world imagery, OpenStreetMap, OpenTopoMap. If the Queensland service doesn't answer, GeoCanvas switches to Esri automatically. |
| Top bar | Layers, Projects, Navigate/Draw, then **Add** (import a file, My maps, Online maps, new drawing layer), **Map** (background cards, lot boundaries, darken imagery, offline maps), Measure, Search, GPS, **Share** (export), Undo/Redo, Team & cloud, **Help** (quick start, offline & online flow chart, tools) and Settings. Labels show on landscape iPads; portrait shows icons. |
| Add › Import a file | KML, KMZ (incl. ground overlays), GeoPDF and DXF (see below), shapefiles (select .shp + .dbf + .shx + .prj together, or a ZIP), GeoJSON, GPX, GeoTIFF. GDA2020, GDA94, MGA zones 49–56, AMG, WGS84, Australian Albers and more are converted automatically. Files without a coordinate system are never guessed: you're asked (MGA 56 offered first). |
| Lot boundaries | Map › Lot boundaries: Queensland DCDB boundaries at every zoom; from zoom 16 lot/plan labels, tap a lot for its details (area, tenure…) and “Add to project” to keep it as a GIS layer. Search finds a lot by lot/plan (“3RP123456”, “Lot 3 on RP123456”). Measuring and plan placing snap to lot corners. Source: Land Parcel Property Framework, © State of Queensland, CC BY 4.0 (a guide, not a survey). |
| GeoPDF maps | Import (⤓) a GeoPDF (Vicmap, NSW and QLD topographic sheets, Avenza-style maps): it places itself from the coordinates inside the PDF, no points to tap. Reads ISO 32000 geospatial PDFs (Esri, Adobe, GDAL) and OGC/TerraGo LGIDict, including compressed object streams. Any map projection works (MGA, VicGrid, NSW Lambert…): the sheet is fitted to its latitude/longitude control points on a local plane (centimetre agreement); GDA94 and AGD maps are shifted to GDA2020. The map is drawn at up to about 200 dpi, cropped to its map frame (margins and legend left off), synced with the project and available offline. Layer options: opacity and “Hide white paper”. PDFs without GeoPDF data open in the plan placer as before. |
| Over the imagery | Layer options (⋯) of GeoPDF sheets, plans and online maps: **Normal**, **Hide white paper** (the map prints onto the imagery; best on light imagery) or **High contrast** (the paper vanishes and the lines glow light over the imagery, colours kept but shown light-for-dark; best on dark bush and forest). “Darken the imagery” dims the basemap photo so lines stand out more. |
| Plans (georeferencing) | Import (⤓) a PDF, PNG or JPG plan: the plan opens beside the map. Tap a point on the plan, then the same point on the map (lot corners snap); 2 points place it (position, scale, rotation), 3+ check the fit with an error per point (optional stretch/skew for scans). Saved as a layer with opacity and “Hide white paper”; ⋯ › Adjust georeferencing; synced; exported in KMZ as a rotated Google Earth overlay. |
| CAD drawings (DXF) | Import (⤓) a DXF: it becomes one locked reference layer drawn in its CAD colours (lines, polylines with arcs, arcs, circles, ellipses, splines, blocks, text and MText; hidden/frozen layers and paper space are left out; hatches aren’t drawn). MGA drawings place themselves after you confirm the zone; drawings in local coordinates open in the plan placer like a PDF. Options: show/hide text, draw in one colour. Measuring and plan placing snap to its vertices. Synced; not included in KML exports. DWG: save as DXF first (Civil 3D: Export to AutoCAD). |
| Photo register | **Photos** in the top bar (iPhone: Photos tab › Register; or the Photo points layer’s ⋯ options) opens every photo point as one table: ✓ checked, photo, name, category, importance, **Taken** (the camera’s own time from the photo, kept separately from when it was pinned), **Checked** (who ticked it and when, from your name in Team & cloud) and note. Tap ✓ when a photo has been checked: the pin gets a green tick. Change category and importance in place; sort by any column (tap the heading again to reverse); filter by text (name, note, who checked), category, importance and All / To check / Checked; **Map** jumps to the pin. **Export CSV** gives an Excel-ready file (name, category, importance, checked, checked by/at, taken, lat/long, MGA2020, GPS accuracy, note, photo count). The tick is also on each photo point’s card, the layer’s ⋯ options can hide checked photos, search understands “to check” and “checked”, and KML/GeoJSON exports carry taken, checked, checked_by and checked_at. Ticks sync with the team like everything else. On a phone the register is full screen with one card per photo. |
| iPhone & Android layout | On a phone, iPhone or Android (e.g. Galaxy S25), held either way up, even with Chrome’s “Desktop site” on, or on any screen up to 640 px wide, GeoCanvas switches to a layout made for one hand and photos: a slim top bar (project, search, cloud), a tab bar at the bottom with **Map · Photos · Camera · Layers · More** and a big camera button in the middle, and a find-me button. **Photos** lists every photo point as big thumbnails with its importance colour, sorted by importance, newest or nearest (with distances), filtered by High +, Critical or a category; tap one to fly to its pin. Tap cards, Layers, GPS, Measure and the Map panel slide up as sheets above the tab bar (swipe down or × to close); the pin stays visible above the card. More holds everything else (import, My maps, online maps, background & offline, measure, GPS, search, share, projects, team, help, settings). Held sideways the bars slim down and the card docks on the right so the pin stays in view. Drawing with Apple Pencil stays on the iPad layout. **Settings › Screen layout** can force Phone or Tablet if a device is guessed wrong. |
| Camera (photo points) | **Camera** in the top bar opens the iPad/iPhone camera straight away. After the shot a quick sheet shows the photo and where the pin will go (your GPS position, else the photo’s own location, else the map centre); pick a **category** (General, Progress, Defect, Safety, Environmental, As-built, or **+ New**) and an **importance** (Info, Low, Medium, High, Critical), add a note if you like, then **Save** or **Save + next photo**. Tapping outside the sheet also saves, so a photo is never lost; Discard throws it away. Photo points go in a “Photo points” layer: pins are coloured by importance with the category’s symbol, names are automatic (“Defect 03”). Tap a pin for its card: change category or importance, add photos and notes, Go, Move pin. The layer’s ⋯ options filter by importance (“High and above”) and category, and rename, add or delete categories (shared with the team). Search finds them by category or importance (“defect”, “critical”); exports carry category, importance and pin colour. On phones the top bar scrolls sideways. |
| Photos | Add photos (camera, photo library or Files) to drawn markers, GPS waypoints and imported KMZ/GIS points or lines: in the marker editor, the details panel or the balloon. GPS › Photo waypoint drops a waypoint with a photo (at the GPS fix, else where the photo was taken). Photos are resized on the iPad (~2000 px), sync to other devices, are kept in backups, and are packed into KMZ exports so they show in Google Earth balloons. |
| Measure (ruler) | Line or Area. Tap points, or tick Freehand and trace a winding track, creek or boundary with the Pencil (fingers still move the map). Shows length, last segment and bearing, or area (ha and m²) and perimeter; drag points to adjust, Undo, and Save to map as a labelled line/area. Distances are on the GRS80 ellipsoid (GDA2020); areas use an equal-area projection. |
| GPS (➤) | Position, accuracy (good/fair/poor), MGA coordinates, altitude, speed, compass, follow-me, track recording, waypoints with notes. Warns when the iPad is Wi-Fi-only (no GPS chip) or the fix is poor/stale. |
| Export (⤒) | KML, KMZ, GeoJSON, GPX, transparent GeoTIFF, PNG + world file, print/PDF of the map, full project backup. Basemap imagery is never included. |
| Layers | Like Google Earth's Places panel: KML/KMZ folders open with ▸, every folder and placemark has its own eye (hiding a folder hides its contents), drag ⠿ to reorder layers. Tap a placemark in the list to fly to it. Also opacity, lock, rename, duplicate, delete, export, colours, labels, "Change coordinate system". |
| Placemark details | Tapping a feature opens a Google Earth style balloon: the KML description (HTML tables, links and photos inside the KMZ) or its BalloonStyle, the ExtendedData / shapefile attributes as a table, plus length/area and position. HTML from files is shown sandboxed (scripts never run). |
| Projects | Saved automatically on the iPad (IndexedDB). Several projects, rename/duplicate/delete, backup and restore. Optional cloud sync between devices (see above). |
| Offline | After the first visit the app works without internet. **Map › Offline maps** › Select an area: the map dims and you drag a box over the area, like a snipping tool, or choose Freehand and draw around it (e.g. along a pipeline corridor, which saves far fewer tiles than a box). Pick the detail (suburb → maximum) and whether to include lot boundaries; the size is shown before downloading. Queensland aerial imagery and QLD cadastre boundaries are saved on the device (never trimmed) and listed with Show / Update / Delete. With no internet the map switches to the saved imagery by itself and enlarges it beyond the saved detail. Esri/OSM basemaps can’t be saved (their terms forbid bulk downloading). |
| My maps | Layers › My maps (or Add › My maps): the team’s map library, in your own folders (e.g. Vicmap 25K › Grampians). GeoPDF sheets go into it automatically; “Import maps” imports GeoPDFs, GeoTIFFs, DXFs or plans straight into the folder you are in; “Online maps” (also Add › Online maps) adds Geoscience Australia / Queensland map services (surface geology, topographic base map, QLD geology, mineral tenements…, read live from their catalogues) into it. Any layer can be moved in with ⋯ › Save to My maps. Add shows a map in the open project; the map is stored once and projects hold a small reference, so the same topo sheet can be in many projects. Search, “Here” (maps covering the view), rename, move between folders, delete. Synced with the team and available offline. |
| Maps in the cloud | A map added to My maps is uploaded once to the team cloud and listed on every device straight away (only its name, outline, thumbnail and a small overview sync). Other devices show it **from the cloud** when online: zoomed out the overview, zoomed in only the pieces on screen (kept for a while). **Download** (⬇, or ⋯ › Download to this device; folder ⋯ › Download all) keeps it on the device for offline use; ⋯ › Remove from this device frees the space (only once the cloud has it all). Rows show 📱 On this device or ☁ In the cloud. Large items (map pieces, photos, big GIS data, ≥ 32 KB) are stored in Cloudflare R2 (bucket `geocanvas-files`); D1 keeps the small data and a marker per R2 item. Older large items move to R2 when first read. |

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
js/cad.js                    DXF reader: CAD drawings as reference layers
js/geopdf.js                 GeoPDF reader (ISO 32000 / OGC LGIDict) and placed map pieces
js/library.js                Online maps: Geoscience Australia / QLD map services, legend, identify
js/mymaps.js                 My maps: the team map library (folders, shared, referenced by projects)
js/offline.js                offline maps: snip an area, save its imagery and lot-boundary tiles
js/ui.js                     top-bar Add menu and Map panel, Help (with the offline/online flow chart), welcome
js/cards.js                  tap cards (one card + actions for everything), Go guidance, search in your own data
js/store.js                  IndexedDB project storage
js/cloud.js                  cloud sync: three-way merge with the team's copy in Cloudflare D1
worker/index.js              Cloudflare Worker: serves the app and the /api/ sync endpoints
wrangler.jsonc, migrations/  Worker configuration (D1 database, R2 bucket geocanvas-files) and D1 database schema
js/app.js, draw.js, panels.js  map, layers, tools, Pencil input, GPS, import/export UI
sw.js, manifest.webmanifest  offline support and Home Screen app
vendor/                      Leaflet 1.9.4, proj4 2.11.0, JSZip 3.10.1, togeojson 5.8.1, geotiff.js 2.1.3, pdf.js 2.16 (legacy build, Apache-2.0)
```

To try it on a computer: `python3 -m http.server` in this folder, then open http://localhost:8000.
