import { useCallback, useEffect, useState } from "react";
import { Mail, Save, Send, Wand2 } from "lucide-react";
import { Button } from "@/components/ui/Button";
import { Switch } from "@/components/ui/Switch";
import { TextField } from "@/components/ui/TextField";
import { useEntrance } from "@/hooks/useGSAPAnim";
import { useT } from "@/i18n";
import { apiGet, apiPatch, apiPost } from "@/services/apiClient";
import { notify } from "@/services/notify";

interface SmtpConfig {
  enabled: boolean;
  host: string;
  port: number;
  username: string;
  password: string;
  fromAddress: string;
  fromName: string;
  useTls: boolean;
}

interface MailTemplate {
  subject: string;
  html: string;
}

interface MailTemplates {
  register: MailTemplate;
  resetPw: MailTemplate;
  bindEmail: MailTemplate;
}

const EMPTY_CFG: SmtpConfig = {
  enabled: false,
  host: "",
  port: 587,
  username: "",
  password: "",
  fromAddress: "",
  fromName: "CCAPI",
  useTls: true,
};

const DEFAULT_TEMPLATES: MailTemplates = {
  register: {
    subject: "【{site}】注册验证码：{code}",
    html: "<p>您正在注册 <b>{site}</b> 账号。验证码：</p><h2>{code}</h2><p>5 分钟内有效。如非本人操作请忽略。</p>",
  },
  resetPw: {
    subject: "【{site}】找回密码验证码：{code}",
    html: "<p>您正在重置 <b>{site}</b> 账号的密码。验证码：</p><h2>{code}</h2><p>5 分钟内有效。如非本人操作请检查账号安全。</p>",
  },
  bindEmail: {
    subject: "【{site}】绑定邮箱验证码：{code}",
    html: "<p>您正在为 <b>{site}</b> 账号绑定此邮箱。验证码：</p><h2>{code}</h2><p>5 分钟内有效。</p>",
  },
};

/** 常见邮件服务商一键填充：参数源自各家官方文档（2024 在线版本）。 */
const PROVIDERS: {
  key: string;
  name: string;
  host: string;
  port: number;
  useTls: boolean;
  hint?: string;
}[] = [
  { key: "gmail", name: "Gmail", host: "smtp.gmail.com", port: 587, useTls: true, hint: "需开启两步验证 + 应用专用密码" },
  { key: "outlook", name: "Outlook / Microsoft 365", host: "smtp.office365.com", port: 587, useTls: true },
  { key: "hotmail", name: "Hotmail / Live", host: "smtp-mail.outlook.com", port: 587, useTls: true },
  { key: "qq", name: "QQ 邮箱", host: "smtp.qq.com", port: 465, useTls: true, hint: "密码需用「授权码」" },
  { key: "163", name: "网易 163", host: "smtp.163.com", port: 465, useTls: true, hint: "密码需用「客户端授权密码」" },
  { key: "126", name: "网易 126", host: "smtp.126.com", port: 465, useTls: true, hint: "密码需用「客户端授权密码」" },
  { key: "sina", name: "新浪", host: "smtp.sina.com", port: 465, useTls: true },
  { key: "yahoo", name: "Yahoo", host: "smtp.mail.yahoo.com", port: 587, useTls: true, hint: "需「应用密码」" },
  { key: "icloud", name: "iCloud", host: "smtp.mail.me.com", port: 587, useTls: true, hint: "需开启两步验证 + App 专用密码" },
  { key: "yandex", name: "Yandex", host: "smtp.yandex.com", port: 465, useTls: true },
  { key: "zoho", name: "Zoho", host: "smtp.zoho.com", port: 587, useTls: true },
  { key: "aliyun", name: "阿里云邮", host: "smtp.aliyun.com", port: 465, useTls: true },
  { key: "tencent", name: "腾讯企业邮", host: "smtp.exmail.qq.com", port: 465, useTls: true },
  { key: "feishu", name: "飞书 / Lark", host: "smtp.feishu.cn", port: 465, useTls: true },
];

export function MailSetting() {
  const t = useT();
  const ref = useEntrance<HTMLDivElement>({ y: 12 });
  const [cfg, setCfg] = useState<SmtpConfig>(EMPTY_CFG);
  const [templates, setTemplates] = useState<MailTemplates>(DEFAULT_TEMPLATES);
  const [saving, setSaving] = useState(false);
  const [testing, setTesting] = useState(false);
  const [testTo, setTestTo] = useState("");
  const [activeTemplate, setActiveTemplate] =
    useState<keyof MailTemplates>("register");

  const load = useCallback(async () => {
    try {
      const r = await apiGet<{ config: SmtpConfig }>("/api/admin/smtp");
      setCfg({ ...EMPTY_CFG, ...r.config });
    } catch (e: any) {
      notify("error", t("common.loadFail"), e?.message);
    }
    try {
      const allCfg = await apiGet<{
        config: { mail_templates?: Partial<MailTemplates> };
      }>("/api/admin/config");
      const stored = allCfg.config?.mail_templates;
      if (stored) {
        setTemplates({
          register: { ...DEFAULT_TEMPLATES.register, ...stored.register },
          resetPw: { ...DEFAULT_TEMPLATES.resetPw, ...stored.resetPw },
          bindEmail: { ...DEFAULT_TEMPLATES.bindEmail, ...stored.bindEmail },
        });
      }
    } catch {
      /* fallback to defaults */
    }
  }, [t]);

  useEffect(() => {
    void load();
  }, [load]);

  const save = async () => {
    setSaving(true);
    try {
      await apiPatch("/api/admin/smtp", cfg);
      await apiPatch("/api/admin/config", { mail_templates: templates });
      notify("success", t("common.saved"));
      await load();
    } catch (e: any) {
      notify("error", t("common.saveFail"), e?.message);
    } finally {
      setSaving(false);
    }
  };

  const test = async () => {
    if (!testTo.trim() || !testTo.includes("@")) {
      notify("error", t("mail.test.needTo"));
      return;
    }
    setTesting(true);
    try {
      await apiPost("/api/admin/smtp/test", { to: testTo });
      notify("success", t("mail.test.sent"));
    } catch (e: any) {
      notify("error", t("mail.test.fail"), e?.message);
    } finally {
      setTesting(false);
    }
  };

  const applyPreset = (preset: typeof PROVIDERS[0]) => {
    setCfg((s) => ({
      ...s,
      host: preset.host,
      port: preset.port,
      useTls: preset.useTls,
    }));
    if (preset.hint) {
      notify("info", `${preset.name} ${t("mail.preset.applied")}`, preset.hint);
    } else {
      notify("success", `${preset.name} ${t("mail.preset.applied")}`);
    }
  };

  const tmpl = templates[activeTemplate];
  const setTmpl = (next: Partial<MailTemplate>) =>
    setTemplates((s) => ({ ...s, [activeTemplate]: { ...s[activeTemplate], ...next } }));

  return (
    <div ref={ref} className="h-full overflow-y-auto px-6 py-6">
      <div className="mx-auto max-w-3xl space-y-6">
        <header className="flex items-end justify-between gap-3">
          <div>
            <h1 className="flex items-center gap-2 text-xl font-semibold">
              <Mail className="h-5 w-5 text-primary" />
              {t("mail.title")}
            </h1>
            <p className="mt-1 text-sm text-muted">{t("mail.subtitle")}</p>
          </div>
          <Button onClick={() => void save()} loading={saving}>
            <Save className="h-3.5 w-3.5" />
            {t("common.save")}
          </Button>
        </header>

        {/* 预设 */}
        <section className="space-y-2 rounded-2xl border border-border bg-surface/60 p-5 backdrop-blur-xl">
          <div className="flex items-center gap-2">
            <Wand2 className="h-4 w-4 text-primary" />
            <h2 className="text-sm font-semibold">{t("mail.preset.title")}</h2>
          </div>
          <p className="text-xs text-muted">{t("mail.preset.desc")}</p>
          <div className="flex flex-wrap gap-1.5">
            {PROVIDERS.map((p) => (
              <button
                key={p.key}
                type="button"
                onClick={() => applyPreset(p)}
                className="rounded-full border border-border bg-surface-2/40 px-2.5 py-1 text-xs text-muted hover:border-primary/40 hover:text-text"
                title={`${p.host}:${p.port}`}
              >
                {p.name}
              </button>
            ))}
          </div>
        </section>

        {/* SMTP 配置 */}
        <section className="space-y-3 rounded-2xl border border-border bg-surface/60 p-5 backdrop-blur-xl">
          <h2 className="text-sm font-semibold">{t("mail.smtp.title")}</h2>
          <label className="flex cursor-pointer items-center justify-between gap-3 rounded-lg px-2 py-2 hover:bg-surface-2/40">
            <span className="text-sm font-medium">{t("mail.enabled")}</span>
            <Switch
              checked={cfg.enabled}
              onChange={(v) => setCfg((s) => ({ ...s, enabled: v }))}
            />
          </label>
          <div className="grid grid-cols-3 gap-3">
            <div className="col-span-2">
              <TextField
                label={t("mail.host")}
                value={cfg.host}
                onChange={(e) => setCfg((s) => ({ ...s, host: e.target.value }))}
                placeholder="smtp.gmail.com"
              />
            </div>
            <TextField
              label={t("mail.port")}
              type="number"
              value={String(cfg.port)}
              onChange={(e) =>
                setCfg((s) => ({ ...s, port: Number(e.target.value) || 587 }))
              }
              placeholder="587"
            />
          </div>
          <TextField
            label={t("mail.username")}
            value={cfg.username}
            onChange={(e) => setCfg((s) => ({ ...s, username: e.target.value }))}
            placeholder="me@example.com"
          />
          <TextField
            label={t("mail.password")}
            type="password"
            value={cfg.password}
            onChange={(e) => setCfg((s) => ({ ...s, password: e.target.value }))}
            placeholder={t("mail.password.ph")}
          />
          <div className="grid grid-cols-2 gap-3">
            <TextField
              label={t("mail.fromAddress")}
              value={cfg.fromAddress}
              onChange={(e) =>
                setCfg((s) => ({ ...s, fromAddress: e.target.value }))
              }
              placeholder="noreply@example.com"
            />
            <TextField
              label={t("mail.fromName")}
              value={cfg.fromName}
              onChange={(e) => setCfg((s) => ({ ...s, fromName: e.target.value }))}
              placeholder="CCAPI"
            />
          </div>
          <label className="flex cursor-pointer items-center justify-between gap-3 rounded-lg px-2 py-2 hover:bg-surface-2/40">
            <span className="text-sm">{t("mail.useTls")}</span>
            <Switch
              checked={cfg.useTls}
              onChange={(v) => setCfg((s) => ({ ...s, useTls: v }))}
            />
          </label>
        </section>

        {/* 邮件模板编辑 */}
        <section className="space-y-3 rounded-2xl border border-border bg-surface/60 p-5 backdrop-blur-xl">
          <h2 className="text-sm font-semibold">{t("mail.tmpl.title")}</h2>
          <p className="text-xs text-muted">{t("mail.tmpl.desc")}</p>
          <div className="flex gap-1.5">
            {(["register", "resetPw", "bindEmail"] as const).map((k) => (
              <button
                key={k}
                type="button"
                onClick={() => setActiveTemplate(k)}
                className={
                  "rounded-lg border px-3 py-1.5 text-xs transition-colors " +
                  (activeTemplate === k
                    ? "border-primary bg-primary/10 text-primary"
                    : "border-border bg-surface-2/40 text-muted hover:text-text")
                }
              >
                {t(`mail.tmpl.${k}` as never)}
              </button>
            ))}
          </div>
          <TextField
            label={t("mail.tmpl.subject")}
            value={tmpl.subject}
            onChange={(e) => setTmpl({ subject: e.target.value })}
          />
          <div>
            <label className="mb-1.5 block text-xs font-medium text-muted">
              {t("mail.tmpl.html")}
            </label>
            <textarea
              value={tmpl.html}
              onChange={(e) => setTmpl({ html: e.target.value })}
              rows={10}
              spellCheck={false}
              className="w-full rounded-xl border border-border bg-surface-2 px-3.5 py-2.5 font-mono text-xs outline-none focus:border-primary/60"
            />
            <p className="mt-1 text-[11px] text-muted/70">
              {t("mail.tmpl.vars")} <code>{"{code}"}</code> <code>{"{site}"}</code>{" "}
              <code>{"{email}"}</code>
            </p>
          </div>
        </section>

        {/* 测试发信 */}
        <section className="space-y-3 rounded-2xl border border-border bg-surface/60 p-5 backdrop-blur-xl">
          <h2 className="text-sm font-semibold">{t("mail.test.title")}</h2>
          <div className="flex gap-2">
            <TextField
              value={testTo}
              onChange={(e) => setTestTo(e.target.value)}
              placeholder={t("mail.test.to.ph")}
              className="flex-1"
            />
            <Button onClick={() => void test()} loading={testing} variant="ghost">
              <Send className="h-3.5 w-3.5" />
              {t("mail.test.btn")}
            </Button>
          </div>
        </section>
      </div>
    </div>
  );
}
