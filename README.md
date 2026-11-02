# Glifo

Editor PDF che modifica le scritte mantenendo il font originale. Un solo codice web (Vite + MuPDF WebAssembly) impacchettato per:

| Piattaforma | Tecnologia | Comando | Output |
|---|---|---|---|
| macOS | Electron | `npm run dist:mac` | `release/Glifo-1.0.0-arm64.dmg` |
| Windows | Electron | `npm run dist:win` | `release/Glifo Setup 1.0.0.exe` |
| iPhone / iPad | Capacitor | `npm run ios` | apre Xcode |
| Android | Capacitor | `npm run android` | apre Android Studio |
| Web / PWA | Vite | `npm run build` | `dist/` (installabile, offline) |

Tutto gira sul dispositivo: nessun server, i PDF non escono mai dal dispositivo.

## Come viene mantenuto il font

Per ogni scritta modificata il motore ([src/engine/engine.js](src/engine/engine.js)) prova, in ordine:

1. **Font originale**: riscrive con la stessa risorsa font del PDF, usando i codici ricavati da ToUnicode/Encoding. È identico all'originale.
2. **Incorporato**: il font del PDF contiene i glifi necessari e viene usato direttamente.
3. **Versione completa**: lo stesso font, preso dai font installati (desktop) o dalla libreria font dell'app. Serve quando il PDF contiene solo un sottoinsieme delle lettere.
4. **Simile**: font standard dello stesso stile, con un avviso all'utente.

Prima della scrittura, il testo originale viene rimosso con una redaction che tocca solo il testo, non immagini e grafica. L'anteprima dal vivo applica la modifica, disegna solo la zona interessata e poi ripristina la pagina.

## Sviluppo

```sh
npm install
npm run dev          # http://localhost:5173
npm run electron     # app desktop in locale
```

Note sull'ambiente:
- npm recente blocca gli script di installazione: se Electron non parte, esegui `npm approve-scripts electron` e reinstalla.
- Il terminale integrato di VS Code imposta `ELECTRON_RUN_AS_NODE=1`, che impedisce a Electron di avviarsi. Usa `env -u ELECTRON_RUN_AS_NODE npm run electron`.
- In sviluppo, `#test?pdf=/test/file.pdf&find=testo&type=nuovo` apre un PDF e simula una modifica, utile per i test automatici.

## Pubblicazione

- **macOS**: per distribuire senza l'avviso "sviluppatore non identificato" servono un certificato *Developer ID* (Apple Developer Program, 99 €/anno) e la notarizzazione. Per i Mac Intel aggiungi `x64` in `build.mac.target.arch` in `package.json`.
- **Windows**: senza firma del codice SmartScreen mostra un avviso al primo avvio. Per l'icona dentro `Glifo.exe` compila su Windows, oppure con Wine, togliendo `signAndEditExecutable: false`.
- **iOS**: apri `ios/App/App.xcodeproj`, scegli il Team di sviluppo e pubblica su App Store Connect. Il progetto usa Swift Package Manager, CocoaPods non serve.
- **Android**: serve Android Studio. Poi *Build → Generate Signed App Bundle* per il Play Store.
- **PWA**: carica `dist/` su un hosting HTTPS qualsiasi. Su iPhone si installa con *Condividi → Aggiungi alla schermata Home*.

Le icone si rigenerano con `npm run icons`, che aggiorna anche le icone e gli splash dei progetti iOS e Android.

## Licenza

MuPDF è distribuito con licenza **AGPL-3.0**: chi distribuisce l'app deve renderne disponibile il codice sorgente con la stessa licenza, oppure acquistare una licenza commerciale da Artifex.
