# ERP-App (nicht im Repo)

Hierhin gehören die Dateien des ERP-Front-Ends (Node/Express), sie sind bewusst nicht eingecheckt:

- `server.js`, `package.json`, `package-lock.json`
- Ordner `public/` mit den HTML-Seiten

Das `Dockerfile` baut daraus das Image `munotstadt-erp`. Das fertige Paket mit allen Dateien liegt als ZIP vor und wird nach `/volume3/docker_v3/erp_tunnel/` auf dem NAS entpackt.
