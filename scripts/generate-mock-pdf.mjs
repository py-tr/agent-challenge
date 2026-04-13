/**
 * scripts/generate-mock-pdf.mjs
 * Generates a realistic multi-page business PDF for testing the Pulse document upload feature.
 * Run: node scripts/generate-mock-pdf.mjs
 */

import { writeFileSync } from "fs";

// ─── PDF builder ──────────────────────────────────────────────────────────────

class PDFBuilder {
  constructor() {
    this.objects = [];
    this.buf = "";
    this.offsets = [];
  }

  addObj(content) {
    const id = this.objects.length + 1;
    this.objects.push({ id, content });
    return id;
  }

  // Encode a stream object; returns [streamId, length]
  stream(text) {
    const len = Buffer.byteLength(text, "latin1");
    const content = `<< /Length ${len} >>\nstream\n${text}\nendstream`;
    return this.addObj(content);
  }

  build() {
    let out = "%PDF-1.4\n";
    const offsets = [];

    for (const obj of this.objects) {
      offsets.push(out.length);
      out += `${obj.id} 0 obj\n${obj.content}\nendobj\n\n`;
    }

    const xrefOffset = out.length;
    out += "xref\n";
    out += `0 ${this.objects.length + 1}\n`;
    out += "0000000000 65535 f \n";
    for (const off of offsets) {
      out += String(off).padStart(10, "0") + " 00000 n \n";
    }

    out += "trailer\n";
    out += `<< /Size ${this.objects.length + 1} /Root 1 0 R >>\n`;
    out += "startxref\n";
    out += `${xrefOffset}\n`;
    out += "%%EOF\n";

    return out;
  }
}

// ─── Content ──────────────────────────────────────────────────────────────────

function page(streamId, parentId) {
  return (
    `<< /Type /Page /Parent ${parentId} 0 R /MediaBox [0 0 612 792]\n` +
    `   /Contents ${streamId} 0 R /Resources << /Font << /F1 ${FONT_ID} 0 R /F2 ${FONT_BOLD_ID} 0 R >> >> >>`
  );
}

// ─── Text layout helpers ──────────────────────────────────────────────────────

function lines(...chunks) {
  return chunks.join("\n");
}

function heading(text, x, y, size = 13) {
  return `/F2 ${size} Tf\n${x} ${y} Td\n(${esc(text)}) Tj`;
}

function body(text, x, y, size = 10) {
  return `/F1 ${size} Tf\n${x} ${y} Td\n(${esc(text)}) Tj`;
}

function esc(s) {
  return s.replace(/\\/g, "\\\\").replace(/\(/g, "\\(").replace(/\)/g, "\\)");
}

// ─── Build ────────────────────────────────────────────────────────────────────

const pdf = new PDFBuilder();

// We'll wire up IDs in order: catalog=1, pages=2, page1=3, page2=4, page3=5,
// stream1=6, stream2=7, stream3=8, font=9, fontBold=10
const FONT_ID = 9;
const FONT_BOLD_ID = 10;

// ── Page 1: Executive Summary ──────────────────────────────────────────────

const p1stream = `BT
${heading("STRATEGIC PARTNERSHIP PROPOSAL", 50, 740, 14)}
0 -18 Td
${body("Prepared by: Pulse AI   |   For: Nexora Capital   |   Confidential", 0, 0, 9)}
0 -14 Td
${body("Date: April 14, 2026   |   Reference: NXC-2026-04-PULSE", 0, 0, 9)}
0 -30 Td
${heading("1. Executive Summary", 0, 0, 12)}
0 -18 Td
${body("Pulse AI proposes a strategic partnership with Nexora Capital to deploy an AI-powered", 0, 0, 10)}
0 -14 Td
${body("executive productivity suite across Nexora's 12-firm portfolio. The system provides", 0, 0, 10)}
0 -14 Td
${body("autonomous inbox triage, calendar conflict resolution, and commitment tracking,", 0, 0, 10)}
0 -14 Td
${body("running entirely on Nosana's decentralised GPU network.", 0, 0, 10)}
0 -24 Td
${body("Proposed deal terms: EUR 480,000 annual licence (40 seats). Pilot: 5 seats, 60 days,", 0, 0, 10)}
0 -14 Td
${body("no charge. Full deployment target: July 1, 2026.", 0, 0, 10)}
0 -30 Td
${heading("2. Problem Statement", 0, 0, 12)}
0 -18 Td
${body("Portfolio executives spend an average of 3.2 hours per day on email triage and", 0, 0, 10)}
0 -14 Td
${body("scheduling — time that could be redirected to capital allocation decisions.", 0, 0, 10)}
0 -14 Td
${body("Missed follow-ups and double-booked meetings cost an estimated EUR 1.2M per year", 0, 0, 10)}
0 -14 Td
${body("in rescheduling overhead and lost deal velocity across the portfolio.", 0, 0, 10)}
0 -30 Td
${heading("3. Proposed Solution", 0, 0, 12)}
0 -18 Td
${body("Pulse deploys as an ElizaOS plugin running on-premise within each firm's cloud", 0, 0, 10)}
0 -14 Td
${body("environment. LLM inference runs on Nosana GPU nodes — no data leaves the client", 0, 0, 10)}
0 -14 Td
${body("environment to third-party AI providers. Key capabilities:", 0, 0, 10)}
0 -14 Td
${body("  - Email classification and draft generation (action-required / follow-up / noise)", 0, 0, 10)}
0 -14 Td
${body("  - Calendar conflict detection with one-click resolution", 0, 0, 10)}
0 -14 Td
${body("  - Commitment tracking: surfaces broken promises before they become problems", 0, 0, 10)}
0 -14 Td
${body("  - Morning briefing: spoken or written daily digest of priorities", 0, 0, 10)}
ET`;

// ── Page 2: Commercial Terms & Timeline ───────────────────────────────────

const p2stream = `BT
${heading("4. Commercial Terms", 50, 740, 12)}
0 -20 Td
${body("Licence Model:       SaaS annual subscription, per-seat pricing", 0, 0, 10)}
0 -14 Td
${body("Pilot (5 seats):     Complimentary - 60 days from contract signature", 0, 0, 10)}
0 -14 Td
${body("Full licence:        EUR 12,000 per seat per year (min. 10 seats)", 0, 0, 10)}
0 -14 Td
${body("Portfolio discount:  15% for 12+ firms signing simultaneously", 0, 0, 10)}
0 -14 Td
${body("Payment:             Annual upfront, invoice on go-live date", 0, 0, 10)}
0 -14 Td
${body("SLA:                 99.5% uptime, 4-hour incident response", 0, 0, 10)}
0 -30 Td
${heading("5. Implementation Timeline", 0, 0, 12)}
0 -20 Td
${body("Week 1-2   (April 14-25):   Legal review and contract signature", 0, 0, 10)}
0 -14 Td
${body("Week 3-4   (April 28-May 9): OAuth credential setup and data access config", 0, 0, 10)}
0 -14 Td
${body("Week 5-6   (May 12-23):     Pilot deployment at Nexora Capital HQ (5 seats)", 0, 0, 10)}
0 -14 Td
${body("Week 7-8   (May 26-June 6): Pilot evaluation, feedback collection", 0, 0, 10)}
0 -14 Td
${body("Week 9-10  (June 9-20):     Portfolio-wide rollout planning", 0, 0, 10)}
0 -14 Td
${body("Week 11-12 (June 23-July 1): Full deployment - 40 seats across 4 firms", 0, 0, 10)}
0 -30 Td
${heading("6. Key Contacts & Approvals Required", 0, 0, 12)}
0 -20 Td
${body("Nexora Capital - Decision makers who must sign off:", 0, 0, 10)}
0 -14 Td
${body("  - Marcus Veld (Managing Partner) - commercial approval above EUR 200k", 0, 0, 10)}
0 -14 Td
${body("  - Sophie Hartmann (CTO) - technical due diligence sign-off", 0, 0, 10)}
0 -14 Td
${body("  - Legal team (attn. Daniel Roos) - data processing agreement (DPA)", 0, 0, 10)}
0 -28 Td
${body("Pulse AI - Contacts:", 0, 0, 10)}
0 -14 Td
${body("  - Partnerships: partnerships@pulse-ai.com", 0, 0, 10)}
0 -14 Td
${body("  - Technical:    engineering@pulse-ai.com", 0, 0, 10)}
0 -14 Td
${body("  - Legal:        legal@pulse-ai.com", 0, 0, 10)}
ET`;

// ── Page 3: Action Items & Risks ──────────────────────────────────────────

const p3stream = `BT
${heading("7. Open Action Items", 50, 740, 12)}
0 -20 Td
${body("The following items are BLOCKING the April 25 contract deadline:", 0, 0, 10)}
0 -18 Td
${body("[URGENT] Marcus Veld to approve budget allocation by April 18.", 0, 0, 10)}
0 -14 Td
${body("[URGENT] Sophie Hartmann to complete security questionnaire by April 21.", 0, 0, 10)}
0 -14 Td
${body("[REQUIRED] Daniel Roos to review DPA draft - sent April 10, awaiting response.", 0, 0, 10)}
0 -14 Td
${body("[REQUIRED] Nexora IT to whitelist Nosana GPU egress IPs by April 23.", 0, 0, 10)}
0 -14 Td
${body("[NICE-TO-HAVE] Introductory call with 3 portfolio CTOs before pilot starts.", 0, 0, 10)}
0 -30 Td
${heading("8. Risk Register", 0, 0, 12)}
0 -20 Td
${body("RISK-01 (High):    Legal review delay pushes pilot start past May 12.", 0, 0, 10)}
0 -14 Td
${body("  Mitigation: Parallel-track DPA and commercial terms review.", 0, 0, 10)}
0 -14 Td
${body("RISK-02 (Medium):  Nosana GPU network latency >2s during peak hours.", 0, 0, 10)}
0 -14 Td
${body("  Mitigation: Reserved node tier available at +EUR 800/month premium.", 0, 0, 10)}
0 -14 Td
${body("RISK-03 (Medium):  Google Workspace admin access delayed at portfolio firms.", 0, 0, 10)}
0 -14 Td
${body("  Mitigation: Pulse supports OAuth delegation - no IT admin required.", 0, 0, 10)}
0 -14 Td
${body("RISK-04 (Low):     Pilot users revert to manual email after training period.", 0, 0, 10)}
0 -14 Td
${body("  Mitigation: Dedicated onboarding session + 30-day check-in call.", 0, 0, 10)}
0 -30 Td
${heading("9. Next Steps", 0, 0, 12)}
0 -20 Td
${body("1. Nexora to send signed Letter of Intent by April 18.", 0, 0, 10)}
0 -14 Td
${body("2. Pulse to deliver final SLA and DPA documents by April 16.", 0, 0, 10)}
0 -14 Td
${body("3. Joint kick-off call: April 22 at 10:00 AM CET (invite sent separately).", 0, 0, 10)}
0 -14 Td
${body("4. Contract signature meeting: April 25, Nexora Capital HQ, Amsterdam.", 0, 0, 10)}
0 -30 Td
${body("This document is confidential. Do not distribute outside Nexora Capital.", 0, 0, 9)}
0 -12 Td
${body("Pulse AI - Registered in Slovakia. VAT: SK2023456789.", 0, 0, 9)}
ET`;

// ─── Wire everything up ───────────────────────────────────────────────────────

// Add objects in order so IDs match expectations
const catalogId   = pdf.addObj(`<< /Type /Catalog /Pages 2 0 R >>`);        // 1
const pagesId     = pdf.addObj(`<< /Type /Pages /Kids [3 0 R 4 0 R 5 0 R] /Count 3 >>`); // 2
const page1Id     = pdf.addObj(page(6, pagesId));   // 3
const page2Id     = pdf.addObj(page(7, pagesId));   // 4
const page3Id     = pdf.addObj(page(8, pagesId));   // 5
const stream1Id   = pdf.stream(p1stream);            // 6
const stream2Id   = pdf.stream(p2stream);            // 7
const stream3Id   = pdf.stream(p3stream);            // 8
const fontId      = pdf.addObj(`<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>`);           // 9
const fontBoldId  = pdf.addObj(`<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold >>`);      // 10

const output = pdf.build();
writeFileSync("scripts/mock-proposal.pdf", output, "binary");
console.log(`Written scripts/mock-proposal.pdf (${output.length} bytes, 3 pages)`);
