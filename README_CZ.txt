FIREUNG SERVER-SIDE MULTIPLAYER v1
=================================

Tohle je Node.js WebSocket server, který počítá online zápas na serveru.
Tím pádem už hráči nejsou závislí na WebRTC/P2P hostovi.

LOKÁLNÍ TEST:
1) Nainstaluj Node.js 18+.
2) Otevři složku server v terminálu.
3) Spusť:
   npm install
   npm start
4) Server poběží na:
   ws://localhost:8787

WEB / PRODUKCE:
- Tenhle server musí běžet na hostingu, který umí Node.js proces nonstop.
- Např. VPS, Render, Railway, Fly.io apod.
- Na běžné Endoře / PHP hostingu tohle většinou nepoběží.
- Web index.html může zůstat na Endoře, ale Node server musí běžet zvlášť.

V index.html je nahoře v JS konstanta FIREUNG_WS_URL.
Pro lokální test je tam ws://localhost:8787.
Pro produkci ji přepiš třeba na:
  wss://tvoje-node-aplikace.onrender.com

CO JE SERVER-SIDE:
- public/private lobby
- pohyb hráčů
- boty
- bomby
- výbuchy
- power-upy
- zásahy, životy, výsledek zápasu
- zvukové eventy se posílají klientům ze serveru

CO ZŮSTÁVÁ NA PHP/MYSQL:
- účet
- login
- chat
- XP/statistiky přes api/save_match.php
