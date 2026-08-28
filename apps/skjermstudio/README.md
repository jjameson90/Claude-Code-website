# Skjermstudio

Lokal skjermopptaks- og videoredigeringsapp. Alt kjører på din egen maskin:
opptakene lagres på skrivebordet, ingenting lastes opp noe sted, og
originalfilene overskrives aldri.

---

## Kom i gang

**Krav:** [Node.js](https://nodejs.org) (LTS-versjon). Ingenting annet
installeres på systemet — Electron og FFmpeg følger med appen og legger seg i
`node_modules/` inne i denne mappen.

**Windows:** dobbeltklikk `Start Skjermstudio.cmd`
**macOS / Linux:** kjør `./start-skjermstudio.sh`

Første gang lastes Electron og FFmpeg ned (noen minutter). Deretter starter
appen på sekunder.

Manuelt, hvis du heller vil det:

```bash
npm install
npm start
```

### Lage en installer

```bash
npm run dist:win     # NSIS-installer + portabel .exe i dist/
npm run dist:mac     # .dmg
npm run dist:linux   # AppImage
```

---

## Slik brukes den

### 1. Ta opp

1. Velg hva som skal tas opp — hele skjermen eller et enkelt vindu.
2. Slå på mikrofon, PC-lyd og kamera, og velg hvilke enheter som skal brukes.
3. Trykk **Start opptak**, eller bruk hurtigtasten (standard `Ctrl+Shift+F9`).
   Hurtigtasten virker også når appen ikke er i fokus.
4. Mens opptaket går vises en rød indikator øverst på skjermen, og
   systemstatusikonet blir blått.
5. Trykk hurtigtasten igjen, eller bruk ikonet i systemstatusfeltet, for å
   stoppe. Redigeringsvinduet åpner seg av seg selv.

**Kameraboblen** vises som en rund, flyttbar boble. Dra den dit du vil ha den,
og rull med musehjulet for å endre størrelsen. Plasseringen blir kameraets
første nøkkelpunkt i redigeringen — der kan du endre alt i etterkant.

Standard hurtigtaster (kan endres i appen):

| Handling | Tast |
| --- | --- |
| Start / stopp opptak | `Ctrl+Shift+F9` |
| Pause / fortsett | `Ctrl+Shift+F10` |

### 2. Rediger

| Handling | Slik gjør du |
| --- | --- |
| Flytte spillehodet | Klikk i lydbølgen |
| Markere et parti | Dra i lydbølgen |
| Klippe bort markeringen | `Delete`, eller **Klipp bort markering** |
| Angre / gjør om | `Ctrl+Z` / `Ctrl+Shift+Z` |
| Spill av | `Mellomrom` |
| Hoppe til neste stille parti | `S`, eller **stille ▶** |
| Sette kameranøkkelpunkt | `K` |
| Zoome i tidslinjen | Musehjul over tidslinjen |
| Lagre prosjektet | `Ctrl+S` |

Stille partier markeres gult i tidslinjen. Terskel og minstelengde justeres i
panelet, og **Fjern alle stille partier** klipper dem bort i én operasjon —
med litt luft i hver ende, slik at talen ikke kappes.

Bortklippede partier vises skravert i rødt og kan alltid tas tilbake.

### 3. Kamera

I **Kamera**-fanen setter du nøkkelpunkter for plassering og størrelse.
Dra en glidebryter og slipp — da settes et nøkkelpunkt der spillehodet står.
Mellom nøkkelpunktene glir kameraet mykt fra det ene til det andre.

- **Fyll bildet** forstørrer kameraet til full skjerm med en myk overgang.
- Når kameraet fyller bildet, dukker det opp en **rund knapp øverst til
  venstre i forhåndsvisningen** som setter det tilbake til boble.
- **Forhåndsvis overgangen** spiller av rett før og etter nærmeste overgang.
- Overgangslengden justeres med egen glidebryter.

Nøkkelpunktene vises som diamanter i tidslinjen — grønn for boble, lilla for
full skjerm. De kan dras sidelengs, og dobbeltklikk sletter dem.

### 4. Bilder, tekst, piler og markeringer

I **Pålegg**-fanen legger du bilder oppå videoen. Bilder kopieres inn i
prosjektmappen, slik at prosjektet fortsatt virker om originalbildet flyttes.
Plassering, størrelse og varighet justeres med glidebrytere, eller ved å dra i
påleggets felt nederst i tidslinjen. Tekst, piler og markeringsrammer virker på
samme måte.

### 5. Eksporter

**Eksporter MP4** lager en H.264/AAC-fil i `eksport/` inne i opptaksmappen.
Kvalitet og bildefrekvens velges i **Eksport**-fanen.

---

## Hvor ting lagres

```
Skrivebord/Skjermopptak/2026-08-28_14-32-05/
├── skjerm.mp4        originalopptak — røres aldri
├── kamera.mp4        kameraet som eget spor
├── prosjekt.json     all redigering (ikke-destruktiv)
├── bilder/           bilder du har lagt oppå videoen
└── eksport/          ferdige MP4-filer
```

All redigering ligger i `prosjekt.json` som en beskrivelse av hva som skal
skje. Ingen redigering endrer opptaksfilene. Et prosjekt kan åpnes igjen når
som helst via **Åpne prosjekt …** i opptaksvinduet.

---

## Hvordan det henger sammen

```
src/
├── main/            hovedprosessen (Node)
│   ├── main.js      vinduer, hurtigtaster, systemstatusikon, IPC
│   ├── ffmpeg.js    all FFmpeg-bruk: konvertering, stillhet, bølgeform, eksport
│   ├── storage.js   opptaksmapper og prosjektfiler
│   ├── settings.js  innstillinger som JSON i appmappen
│   └── roykttest.js automatisk ende-til-ende-test
├── preload/         den eneste broen mellom grensesnitt og disk
├── shared/          ren logikk, uten avhengigheter (brukes av begge sider)
│   ├── timeline.mjs kildetid ⇄ redigert tid, klipp og segmenter
│   ├── keyframes.mjs kameraets nøkkelpunkter og overganger
│   ├── silence.mjs  tolkning av FFmpegs stillhetsdeteksjon
│   └── project.mjs  prosjektformatet
└── renderer/
    ├── recorder/    opptaksvinduet
    ├── overlay/     den røde opptaksindikatoren
    ├── bubble/      kameraboblen (forhåndsvisning + kameraopptak)
    └── editor/      redigeringsvinduet
        ├── kompositor.mjs tegner ett bilde — brukes av både forhåndsvisning og eksport
        ├── tidslinje.mjs  tidslinjen på lerret
        ├── eksport.mjs    eksportkjeden
        └── historikk.mjs  angre / gjør om
```

### Opptak

Skjermen og lyden tas opp av `MediaRecorder` i opptaksvinduet; kameraet tas
opp i boblevinduet. Begge strømmer databiter til hovedprosessen, som skriver
dem rett til disk — minnebruken holder seg lav uansett hvor langt opptaket er.
Etterpå konverteres begge til MP4 med fast bildefrekvens, og forskyvningen
mellom sporene måles og lagres i prosjektfilen.

### Synkronisering ved eksport

Dette er den delen som er lettest å få galt, så den er løst slik:

1. **Bildet** tegnes av `kompositor.mjs` — samme kode som forhåndsvisningen,
   så det du ser er det du får — og spilles inn i sanntid fra et lerret.
2. **Lyden** bygges helt uavhengig, direkte fra originalfilene, med FFmpegs
   `atrim` + `concat` + `amix`. Klippene treffer dermed nøyaktig, uansett hva
   som skjer med bildet.
3. **Til slutt** låses lengden: bildets tidsstempler strekkes med `setpts` til
   nøyaktig den lengden tidslinjen sier. Sanntidsinnspilling bommer alltid med
   noen promille, og dette fjerner avviket i stedet for å la det bygge seg opp.

Konsekvensen er at eksporten tar omtrent like lang tid som videoen varer.
Til gjengjeld stemmer forhåndsvisningen alltid med resultatet, og lyden holder
seg synkron uansett hvor mange klipp som er lagt inn.

---

## Testing

```bash
npm test        # 30 enhets- og FFmpeg-tester (krever ingen skjerm)
npm run roykttest   # full ende-til-ende-test: opptak → redigering → eksport
```

`npm test` dekker tidslinjematematikken, stillhetstolkningen, kameraets
nøkkelpunkter, og kjører ekte FFmpeg-operasjoner mot en generert testfil —
blant annet at et klippet lydspor får riktig lengde og at stillheten faktisk
er borte etterpå.

`npm run roykttest` starter hele appen med syntetisk kamera og mikrofon, tar
opp noen sekunder, klipper, setter et kameranøkkelpunkt, eksporterer, og
kontrollerer at MP4-filen har riktig lengde og lydspor. `ROYKTTEST_SEKUNDER`
styrer lengden, og `ROYKTTEST_SKJERMBILDER=<mappe>` lagrer skjermbilder av
vinduene underveis.

> Kjører du som root i en container, må Electron startes med `--no-sandbox`:
> `xvfb-run -a electron . --roykttest --no-sandbox`

---

## Forskjeller mellom plattformene

| | Windows | macOS | Linux |
| --- | --- | --- | --- |
| Skjerm- og kameraopptak | ✅ | ✅ | ✅ |
| Global hurtigtast | ✅ | ✅ | ✅ |
| PC-lyd direkte (loopback) | ✅ | ✅ (13+) | ❌ |
| Boble og indikator holdes utenfor opptaket | ✅ | ✅ | ❌ |

På **Linux** finnes ikke loopback-opptak av systemlyd. Appen oppdager dette,
slår av valget, og ber deg i stedet velge en «monitor»-enhet i mikrofonlisten
(PulseAudio/PipeWire gir vanligvis en slik). Samme sted finnes valget
**Skjul boblen under opptak**, siden vinduer på Linux ikke kan holdes utenfor
skjermdeling — uten det havner kameraboblen i selve skjermopptaket i tillegg
til på sitt eget spor.

På **macOS** må appen få tilgang til skjermopptak, mikrofon og kamera under
Systeminnstillinger → Personvern og sikkerhet, første gang den brukes.

---

## Hva som gjenstår

Grunnstrukturen er på plass for alt nedenfor, men følgende er verdt å bygge
videre på:

- **Pause under opptak** stopper begge `MediaRecorder`-ene samtidig. Ved svært
  mange pauser i ett langt opptak kan sporene teoretisk gli fra hverandre.
  En sikrere løsning er å la opptaket gå og heller markere pausene som klipp i
  prosjektfilen.
- **Direkteredigering i forhåndsvisningen.** Pålegg og kameraboble flyttes i dag
  med glidebrytere og i tidslinjen. Å kunne dra dem rett i bildet ville vært
  raskere; kompositoren regner allerede i normaliserte koordinater, så det som
  mangler er treffdeteksjon og drahåndtering på lerretet.
- **Eksport raskere enn sanntid.** Dagens kjede spiller inn bildet i sanntid.
  Med `WebCodecs` (`VideoEncoder` + `VideoDecoder`) kan bildene kodes så fort
  maskinen klarer. `kompositor.mjs` kan gjenbrukes uendret; det er bare
  drivverket i `eksport.mjs` som må skrives om.
- **Områdeopptak.** Knappen «Velg utsnitt i editoren» tar opp hele kilden og
  lar deg beskjære etterpå, som beholder full oppløsning i originalen. Ekte
  områdevalg før opptak krever et eget markeringsvindu.
- **Flere kameraformer** enn sirkel og full skjerm (avrundet rektangel finnes
  allerede i `cameraRect`, men er ikke eksponert i grensesnittet).
