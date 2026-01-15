# Alpenlodge – Projekt‑Wissen (Single Source of Truth)
Stand: 2026-01-15

Dieses Dokument ist **die Referenz** für Regeln, Architektur und Arbeitsweise.
Ziel: keine Verwirrung mehr bei wiederkehrenden Themen (z. B. Zuordnung Wohneinheiten ↔ Smoobu IDs).

---

## 1) Leitbild
Der Concierge hat **zwei Gesichter**:

1) **Auskunftsmaschine**  
   - Antworten/Listen kommen aus verifizierten Wissensdaten.
   - Keine erfundenen Orte/Angebote.
   - Links werden **separat** (nicht im Fließtext) ausgegeben.

2) **Buchungsmaschine**  
   - UI (Website) führt sauber durch: Zeitraum → Kategorie → Option → Gäste → buchen.
   - Backend spricht mit Smoobu (keine Secrets im Browser).

---

## 2) Architektur
**Frontend (Website + Widget)**  
- Enthält UI und ruft Backend‑Endpoints auf.
- Darf keine Secrets enthalten.

**Backend (Node/Express)**  
- Enthält Business‑Logik, Guardrails, Integrationen, Token/Rate‑Limit.
- Spricht Smoobu API serverseitig.

**Smoobu**  
- Source of truth für Availability, Rates, Reservations.

---

## 2.1 System‑Blueprint (Draft aus draw.io, noch ohne feste Connections)
Stand: 2026-01-15

Du hast im Diagramm folgende Bausteine skizziert (vereinfacht, ohne Platzhalter‑„Item 1/2/3“):

### Frontends
- **Homepage** – Public Website + Concierge Widget + Einstieg ins Buchungstool
- **Front end PMS** – Property Management UI (intern)
- **Frontend Admin** – Admin UI (intern)
- **GIS (Gast Informationssystem)** – Guest Info System UI (z.B. Check-in, House rules, Infos)

### Services
- **DB Service** – Zentrale Datenhaltung + Registry + Knowledge + Mapping
- **HP Service** – Homepage/Content APIs (falls benötigt)
- **GIS Service** – Guest Info APIs (Templates, Regeln, Links)
- **PMS Service** – PMS APIs (Bookings, Guests, Tasks)
- **Admin Service** – Admin APIs (Users, Roles, Audit, Config)

### Connectors (externe Systeme)
- **OpenAI API** – LLM / Assistenz (Concierge, Text-Tools)
- **Smoobu API** – Availability/Rates/Reservations (Source of truth)
- **E-Mail (SMTP / Sentmail)** – Transactional Emails
- **Account (ISO 20022 CAMT/EBICS)** – Zahlungsabgleich / Kontoauszüge
- **Accounting (DATEV …)** – Buchhaltung/Export
- **Telefonie (Voice ↔ Text)** – Voice-to-text / Text-to-voice
- **WhatsApp** – Guest messaging / Support
- **Social Media (push only)** – FB/Instagram/TikTok publishing
- **CRM System (Tiger CRM)** – CRM sync / leads

### Vorschlag für die *erste* sinnvolle Connection‑Logik (änderbar)
- **Alle Frontends sprechen ausschließlich mit Services** (HTTP/JSON).
- **Services sprechen mit DB Service** (Zustand, Registry, Mapping, Knowledge).
- **Externe Systeme nur über Connector‑Schicht** (keine Secrets im Browser).

```mermaid
flowchart LR
  subgraph Frontends
    HP[Homepage]
    PMSFE[Front end PMS]
    AdminFE[Frontend Admin]
    GISFE[GIS (Gast Informationssystem)]
  end

  subgraph Services
    HPsvc[HP Service]
    PMSsvc[PMS Service]
    GISsvc[GIS Service]
    Adminsvc[Admin Service]
    DBsvc[DB Service]
  end

  subgraph Connectors
    Smoobu[Smoobu API]
    OpenAI[OpenAI API]
    SMTP[SMTP / Sentmail]
    Bank[ISO 20022 / CAMT / EBICS]
    Datev[DATEV / Accounting]
    Tel[Telefonie (Voice↔Text)]
    WA[WhatsApp]
    Social[Social (push)]
    CRM[Tiger CRM]
  end

  %% Proposed core connections (can be refined)
  HP --> HPsvc
  PMSFE --> PMSsvc
  AdminFE --> Adminsvc
  GISFE --> GISsvc

  HPsvc --> DBsvc
  PMSsvc --> DBsvc
  GISsvc --> DBsvc
  Adminsvc --> DBsvc

  PMSsvc --> Smoobu
  HPsvc --> OpenAI
  GISsvc --> OpenAI

  Adminsvc --> SMTP
  Adminsvc --> Bank
  Adminsvc --> Datev

  GISsvc --> WA
  GISsvc --> Tel
  HPsvc --> Social
  PMSsvc --> CRM
```

> Hinweis: Das Mermaid‑Diagramm ist ein **Vorschlag** (keine endgültige Wahrheit). Es hilft, dass wir beim modularen Ausbau immer denselben „Blick von oben“ haben.

## 3) Daten – „Source of Truth“
### 3.1 Wohneinheiten / Units‑Mapping (WICHTIG)
- **Definition:** „apartmentId“ = Smoobu Apartment ID.
- **Einheit‑Mapping ist gelöst**: es gibt EINEN Source‑of‑Truth, aus einer Excel‑Liste abgeleitet.
- Das Mapping liegt in einer Datei (JSON), die Backend und Frontend gleich interpretieren.

Regel:
- Bei Problemen niemals „raten“, sondern Mapping‑Quelle prüfen/aktualisieren.

### 3.2 Wissensdaten (verifiziert)
- Alle verifizierten Knowledge‑JSONs müssen **aktiv** sein.
- Dateiname ist **irrelevant** (der Inhalt entscheidet).
- Kategorien/Typen werden normalisiert.

---

## 4) Deploy-Regeln (Assets)
**Große Dateien (Bilder/Filme)** dürfen beim Deploy **nicht gelöscht** werden.

Regel:
- Code (html/css/js/mjs/json) kann mit `--delete` synchronisiert werden.
- Assets (jpg/png/svg/mp4/…) werden **niemals** gelöscht.
- Einmaliges Aufräumen:
  - „Unreferenzierte“ Assets werden in `_unused_assets/<timestamp>/...` verschoben (nicht gelöscht).

---

## 5) Arbeitsweise: Atomic / modular

## 5.1 Kommunikations‑Standard (wichtig)
- **Ein Protokoll:** HTTP/JSON (keine Mischformen pro Modul).
- **Ein Contract‑Stil:** Jede API hat einen klaren Request/Response‑Contract (im Registry JSON).
- **Eine Sprache im Code‑Kern:** Node/JS (ESM) ist aktuell gesetzt – optional später TypeScript, aber nicht mischen „wild“.

Große Änderungen werden vermieden. Wir arbeiten in **kleinen Modulen**:

- Jede Änderung = kleiner Patch mit klarer Funktion.
- Zu jedem Modul gibt es:
  - Zweck
  - Eingaben/Outputs (Contract)
  - Tests / Smoke‑Checks
  - Rollback‑Strategie

---

## 6) Kommunikation / Begriffe
- „Unit“ = Unterkunft in der Alpenlodge (Marketing/Website)
- „Apartment“ = Smoobu Entity (ID = apartmentId)
- „offerToken“ = kurzlebiges Token für Buchungsangebot (optional)

---

## 7) Registry (Maschinenlesbar)
Alle Namen/Contracts/Env‑Keys stehen zusätzlich in `docs/PROJECT_REGISTRY.json`.
Diese Datei ist die „kleine Datenbank“, gegen die wir bei Änderungen prüfen.
