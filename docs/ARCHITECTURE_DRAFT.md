# Architecture Draft (aus draw.io)
Stand: 2026-01-15

Dieses Dokument ist die **Text-Referenz** zum draw.io Draft.

## 1) Zielbild
Ein offenes PMS/CRM-System mit **atomic / modularer Entwicklung**:
- kleine, testbare Module
- klare Contracts
- einheitliche Namen (Registry)
- Integrationen nur über Connector-Schicht

## 2) Komponenten (aus dem Draft)
### Frontends
- frontend.homepage: Homepage
- frontend.pms: Front end PMS
- frontend.admin: Frontend Admin
- frontend.gis: GIS (Gast Informationssystem)

### Services
- svc.db: DB Service
- svc.hp: HP Service
- svc.gis: GIS Service
- svc.pms: PMS Service
- svc.admin: Admin Service

### Connectors
- connector.openai: OpenAI API
- connector.smoobu: Smoobu API
- connector.smtp: E-Mail (SMTP / Sentmail)
- connector.bank_iso20022: Account (ISO 20022 CAMT/EBICS)
- connector.accounting_datev: Accounting (DATEV …)
- connector.telephony: Telefonie (Voice ↔ Text)
- connector.whatsapp: WhatsApp
- connector.social_push: Social Media (push only)
- connector.crm_tiger: CRM System (Tiger CRM)

## 3) Proposed Connections (erste Version, nicht final)
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

## 4) Entwicklungsstrategie (damit nichts mehr „wegbricht“)
1. **Design/Registry aktualisieren**
2. **Mini-Modul implementieren**
3. **Smoke-Test**
4. **Deploy**
5. **Nächster Atom**

Hinweis: Dieses Repo startet aktuell mit Concierge/Booking/Knowledge und wächst dann in Richtung „PMS/CRM“.
