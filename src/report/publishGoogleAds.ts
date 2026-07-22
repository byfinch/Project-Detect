/**
 * Publish Google Ads competitive report: disk pack + optional SendGrid.
 */
import type { AppConfig } from "../config.js";
import { logger } from "../logger.js";
import {
  buildGoogleAdsReport,
  writeGoogleAdsReportFiles,
  googleAdsReportToHtml,
  type GoogleAdsReport,
  type GoogleAdsReportFiles,
} from "./googleAdsReport.js";
import { sendViaSendGrid } from "./sendgrid.js";

export async function publishGoogleAdsReport(opts: {
  config: AppConfig;
  scanId?: number;
  from?: string;
  to?: string;
  email?: boolean;
}): Promise<{ report: GoogleAdsReport; files: GoogleAdsReportFiles; emailed: boolean }> {
  const report = buildGoogleAdsReport({
    outputDir: opts.config.output.dir,
    scanId: opts.scanId,
    from: opts.from,
    to: opts.to,
    googleDomain: opts.config.google?.domain,
    country: opts.config.google?.gl,
  });
  const files = writeGoogleAdsReportFiles(report, opts.config.output.dir);
  logger.info(
    {
      dir: files.dir,
      advertisers: report.advertisers.length,
      inventory: report.inventory.length,
      top: report.topAdvertiser?.displayDomain,
    },
    `Google Ads raporu yazıldı: ${report.advertisers.length} reklamveren · ${report.inventory.length} gösterim · ${files.dir}`
  );

  let emailed = false;
  // Explicit email:true always tries; auto path uses autoEmailOnScan || emailEnabled
  const shouldEmail =
    opts.email === true ||
    (opts.email !== false &&
      (opts.config.report.autoEmailOnScan || opts.config.report.emailEnabled));

  if (shouldEmail) {
    const apiKey = opts.config.report.sendgridApiKey || process.env.SENDGRID_API_KEY || "";
    const from = opts.config.report.from;
    const to = opts.config.report.to;
    if (!apiKey || !from || !to.length) {
      if (opts.email === true) {
        throw new Error("SendGrid için SENDGRID_API_KEY + REPORT_FROM + REPORT_TO gerekli");
      }
      logger.debug("Google Ads report email skipped — SendGrid not configured");
    } else {
      const subject = [
        "Google Ads SERP",
        report.topAdvertiser ? `#1 ${report.topAdvertiser.displayDomain}` : "rapor",
        `${report.scans.totalAdImpressions} gösterim`,
        `${report.clicks.success} tık ok`,
      ].join(" · ");
      const result = await sendViaSendGrid({
        apiKey,
        from,
        to,
        subject,
        html: googleAdsReportToHtml(report),
        text: report.summaryText,
        attachments: [
          { path: files.summaryJson },
          { path: files.advertisersCsv },
          { path: files.inventoryCsv },
          { path: files.summaryTxt },
        ],
      });
      emailed = result.ok;
      if (!result.ok) {
        logger.warn({ status: result.status, body: result.body.slice(0, 300) }, "Google Ads report email failed");
      }
    }
  }

  return { report, files, emailed };
}
