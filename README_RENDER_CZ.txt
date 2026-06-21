FIREUNG server-side multiplayer - Render nasazeni

1) Nahraj tyto soubory do noveho GitHub repozitare.
2) Na Render.com dej New > Web Service.
3) Vyber GitHub repozitar.
4) Nastaveni:
   - Runtime: Node
   - Build Command: npm install
   - Start Command: npm start
   - Environment variable ALLOWED_ORIGINS: https://fireung.eu,https://www.fireung.eu
5) Po deployi dostanes adresu typu https://fireung-server.onrender.com
6) Do hry se pak musi nastavit WebSocket adresa:
   wss://fireung-server.onrender.com

Poznamka: Endora zustava pro index.html, api/, MySQL, profil a chat. Render hostuje jen realtime WebSocket multiplayer.


UPDATE v2:
- Public lobby je rozdelena na Zalozit public a Najit public.
- Server uz sam nevytvari public room pri hledani.
- Pridane agresivnejsi cisteni starych lobby.
