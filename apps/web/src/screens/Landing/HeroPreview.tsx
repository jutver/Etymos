import { motion } from "motion/react";
import { GraduationCap } from "@phosphor-icons/react";
import { SimilarityBadge, SeverityTag } from "../../components/Severity";
import { t } from "../../lib/i18n";

export function HeroPreview() {
  return (
    <motion.div
      initial={{ opacity: 0, y: 24, rotate: -2 }}
      animate={{ opacity: 1, y: 0, rotate: -2 }}
      transition={{ duration: 0.7, ease: [0.16, 1, 0.3, 1], delay: 0.15 }}
      className="relative w-full max-w-md rounded-[var(--radius-card-lg)] border border-line bg-white p-5 shadow-[var(--shadow-pop)]"
    >
      <div className="flex items-center justify-between border-b border-line pb-4">
        <div>
          <p className="text-xs font-semibold text-ink-500">{t("Bien-doi-khi-hau-DBSCL.docx")}</p>
          <p className="text-[0.6875rem] text-ink-300">{t("Checked just now")}</p>
        </div>
        <span className="rounded-full bg-success-bg px-2.5 py-1 text-[0.6875rem] font-bold text-success">
          {t("Report ready")}</span>
      </div>

      <div className="py-4">
        <SimilarityBadge score={34} />
      </div>

      <motion.div
        initial={{ opacity: 0, y: 10 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.6, delay: 0.5 }}
        className="rounded-[var(--radius-card)] border border-severity-high-line bg-severity-high-bg/40 p-4"
      >
        <div className="flex items-center justify-between">
          <SeverityTag severity="high" />
          <span className="flex items-center gap-1 text-[0.6875rem] font-medium text-ink-500">
            <GraduationCap size={13} />{" "}{t("Academic")}</span>
        </div>
        <p className="mt-2.5 text-xs leading-relaxed text-ink-700">
          "...đến năm 2050, khoảng 38% diện tích Đồng bằng sông Cửu Long có nguy cơ..."
        </p>
        <div className="mt-2.5 rounded-lg bg-white px-3 py-2">
          <p className="text-[0.625rem] font-bold uppercase tracking-wide text-brand-600">
            {t("Why this is flagged")}</p>
          <p className="mt-1 text-[0.6875rem] leading-relaxed text-ink-500">
            {t("Same figures and sentence structure as the source, only a few words changed.")}</p>
        </div>
      </motion.div>
    </motion.div>
  );
}
