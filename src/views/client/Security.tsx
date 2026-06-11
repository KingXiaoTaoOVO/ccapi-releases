import { useCallback, useEffect, useState } from "react";
import {
  Fingerprint,
  Link2,
  KeyRound,
  Shield,
  ShieldCheck,
  Trash2,
} from "lucide-react";
import { Button } from "@/components/ui/Button";
import { Modal } from "@/components/ui/Modal";
import { TextField } from "@/components/ui/TextField";
import { useEntrance } from "@/hooks/useGSAPAnim";
import { useT } from "@/i18n";
import { apiDelete, apiGet, apiPost } from "@/services/apiClient";
import { notify } from "@/services/notify";
import { confirm } from "@/store/useConfirmStore";

interface Passkey {
  id: number;
  credentialId: string;
  nickname: string | null;
  signCount: number;
  lastUsedAt: string | null;
  createdAt: string | null;
}

interface OAuthLink {
  id: number;
  providerCode: string;
  externalId: string;
  externalName: string | null;
  createdAt: string | null;
}

interface OAuthProvider {
  id: number;
  code: string;
  displayName: string;
  enabled: number;
}

export function Security() {
  const t = useT();
  const ref = useEntrance<HTMLDivElement>({ y: 12 });

  // 2FA
  const [twoFaEnabled, setTwoFaEnabled] = useState(false);
  const [setupOpen, setSetupOpen] = useState(false);
  const [setupData, setSetupData] = useState<{
    secret: string;
    provisioningUri: string;
    qrDataUrl: string;
    recoveryCodes: string[];
  } | null>(null);
  const [otpCode, setOtpCode] = useState("");

  // Passkey
  const [passkeys, setPasskeys] = useState<Passkey[]>([]);

  // OAuth
  const [providers, setProviders] = useState<OAuthProvider[]>([]);
  const [links, setLinks] = useState<OAuthLink[]>([]);

  const reload = useCallback(async () => {
    try {
      const [a, b, c] = await Promise.all([
        apiGet<{ enabled: boolean }>("/api/me/2fa/status"),
        apiGet<{ passkeys: Passkey[] }>("/api/me/passkey/list"),
        apiGet<{ links: OAuthLink[] }>("/api/me/oauth/links"),
      ]);
      setTwoFaEnabled(a.enabled);
      setPasskeys(b.passkeys);
      setLinks(c.links);
      // 公开 provider 列表（通过 site/info 或 admin 接口）—— 这里没有公开 list 接口，
      // 用 admin 接口（普通用户没权限会 403，前端 catch 后留空数组）
      const p = await apiGet<{ providers: OAuthProvider[] }>(
        "/api/admin/oauth/providers",
      ).catch(() => ({ providers: [] as OAuthProvider[] }));
      setProviders(p.providers.filter((x) => x.enabled));
    } catch {
      // ignore
    }
  }, []);

  useEffect(() => {
    void reload();
  }, [reload]);

  const startSetup = async () => {
    try {
      const r = await apiPost<{
        secret: string;
        provisioningUri: string;
        qrDataUrl: string;
        recoveryCodes: string[];
      }>("/api/me/2fa/setup", {});
      setSetupData(r);
      setSetupOpen(true);
    } catch (e: any) {
      notify("error", t("sec.2fa.setup.fail"), e?.message);
    }
  };

  const confirmEnable = async () => {
    if (otpCode.length !== 6) return;
    try {
      await apiPost("/api/me/2fa/enable", { code: otpCode });
      notify("success", t("sec.2fa.enabled"));
      setSetupOpen(false);
      setOtpCode("");
      await reload();
    } catch (e: any) {
      notify("error", t("sec.2fa.verify.fail"), e?.message);
    }
  };

  const disable2fa = async () => {
    const code = window.prompt(t("sec.2fa.disable.prompt"));
    if (!code) return;
    try {
      await apiPost("/api/me/2fa/disable", { code });
      notify("success", t("sec.2fa.disabled"));
      await reload();
    } catch (e: any) {
      notify("error", t("sec.2fa.disable.fail"), e?.message);
    }
  };

  const deletePasskey = async (p: Passkey) => {
    const ok = await confirm({
      title: t("sec.passkey.del.title", { name: p.nickname ?? p.credentialId.slice(0, 8) }),
      level: "danger",
    });
    if (!ok) return;
    try {
      await apiDelete(`/api/me/passkey/${p.id}`);
      await reload();
    } catch (e: any) {
      notify("error", t("common.delFail"), e?.message);
    }
  };

  const registerPasskey = async () => {
    if (!("credentials" in navigator)) {
      notify("error", t("sec.passkey.noBrowser"));
      return;
    }
    try {
      const opts = await apiPost<{
        challenge: string;
        rpId: string;
        rpName: string;
        userId: string;
        userName: string;
      }>("/api/me/passkey/register-options", {});
      const cred = await (navigator.credentials as any).create({
        publicKey: {
          challenge: b64urlToBytes(opts.challenge),
          rp: { id: opts.rpId, name: opts.rpName },
          user: {
            id: b64urlToBytes(opts.userId),
            name: opts.userName,
            displayName: opts.userName,
          },
          pubKeyCredParams: [
            { type: "public-key", alg: -7 },
            { type: "public-key", alg: -257 },
          ],
          authenticatorSelection: {
            residentKey: "preferred",
            userVerification: "preferred",
          },
          timeout: 60_000,
          attestation: "none",
        },
      });
      if (!cred) {
        notify("error", t("sec.passkey.cancelled"));
        return;
      }
      const c = cred as PublicKeyCredential;
      const credentialId = bytesToB64Url(new Uint8Array(c.rawId));
      const publicKey = bytesToB64Url(
        new Uint8Array(
          (c.response as AuthenticatorAttestationResponse).getPublicKey?.() ??
            (c.response as AuthenticatorAttestationResponse).attestationObject,
        ),
      );
      const nickname = window.prompt(t("sec.passkey.nickname.prompt")) ?? "";
      await apiPost("/api/me/passkey/register", {
        credentialId,
        publicKey,
        challenge: opts.challenge,
        nickname,
      });
      notify("success", t("sec.passkey.registered"));
      await reload();
    } catch (e: any) {
      notify("error", t("sec.passkey.fail"), e?.message ?? String(e));
    }
  };

  const startOAuth = async (code: string) => {
    const redirect = `${window.location.origin}/oauth-callback`;
    try {
      const r = await apiGet<{ authorizeUrl: string }>(
        `/api/oauth/${code}/start?redirectUri=${encodeURIComponent(redirect)}`,
      );
      window.location.href = r.authorizeUrl;
    } catch (e: any) {
      notify("error", t("sec.oauth.startFail"), e?.message);
    }
  };

  const unlink = async (l: OAuthLink) => {
    const ok = await confirm({
      title: t("sec.oauth.unlink.title", { name: l.providerCode }),
      level: "danger",
    });
    if (!ok) return;
    try {
      await apiDelete(`/api/me/oauth/links/${l.id}`);
      await reload();
    } catch (e: any) {
      notify("error", t("common.delFail"), e?.message);
    }
  };

  return (
    <div ref={ref} className="h-full overflow-y-auto px-6 py-6">
      <div className="mx-auto max-w-2xl space-y-6">
        <header>
          <h1 className="flex items-center gap-2 text-xl font-semibold">
            <Shield className="h-5 w-5 text-primary" />
            {t("sec.title")}
          </h1>
          <p className="mt-1 text-sm text-muted">{t("sec.subtitle")}</p>
        </header>

        {/* 2FA */}
        <section className="rounded-2xl border border-border bg-surface/60 p-5 backdrop-blur-xl">
          <div className="flex items-center gap-3">
            <ShieldCheck className="h-5 w-5 text-primary" />
            <div className="min-w-0 flex-1">
              <p className="text-sm font-semibold">{t("sec.2fa.title")}</p>
              <p className="text-xs text-muted">
                {twoFaEnabled
                  ? t("sec.2fa.statusOn")
                  : t("sec.2fa.statusOff")}
              </p>
            </div>
            {twoFaEnabled ? (
              <Button
                size="sm"
                variant="ghost"
                onClick={() => void disable2fa()}
                className="text-danger hover:bg-danger/10"
              >
                {t("sec.2fa.disable")}
              </Button>
            ) : (
              <Button size="sm" onClick={() => void startSetup()}>
                {t("sec.2fa.enable")}
              </Button>
            )}
          </div>
        </section>

        {/* Passkey */}
        <section className="space-y-3 rounded-2xl border border-border bg-surface/60 p-5 backdrop-blur-xl">
          <div className="flex items-center justify-between gap-2">
            <div className="flex items-center gap-3">
              <Fingerprint className="h-5 w-5 text-primary" />
              <div>
                <p className="text-sm font-semibold">{t("sec.passkey.title")}</p>
                <p className="text-xs text-muted">{t("sec.passkey.subtitle")}</p>
              </div>
            </div>
            <Button size="sm" onClick={() => void registerPasskey()}>
              {t("sec.passkey.add")}
            </Button>
          </div>
          {passkeys.length === 0 ? (
            <p className="text-xs text-muted">{t("sec.passkey.empty")}</p>
          ) : (
            passkeys.map((p) => (
              <div
                key={p.id}
                className="flex items-center gap-3 rounded-xl border border-border bg-surface-2/40 px-3 py-2"
              >
                <KeyRound className="h-4 w-4 text-muted" />
                <div className="min-w-0 flex-1">
                  <p className="truncate text-sm">
                    {p.nickname ?? p.credentialId.slice(0, 12) + "…"}
                  </p>
                  <p className="text-[10px] text-muted">
                    {p.lastUsedAt ?? p.createdAt}
                  </p>
                </div>
                <Button
                  size="sm"
                  variant="ghost"
                  onClick={() => void deletePasskey(p)}
                  className="text-danger hover:bg-danger/10"
                >
                  <Trash2 className="h-3.5 w-3.5" />
                </Button>
              </div>
            ))
          )}
        </section>

        {/* OAuth */}
        <section className="space-y-3 rounded-2xl border border-border bg-surface/60 p-5 backdrop-blur-xl">
          <div className="flex items-center gap-3">
            <Link2 className="h-5 w-5 text-primary" />
            <div>
              <p className="text-sm font-semibold">{t("sec.oauth.title")}</p>
              <p className="text-xs text-muted">{t("sec.oauth.subtitle")}</p>
            </div>
          </div>
          {providers.length === 0 ? (
            <p className="text-xs text-muted">{t("sec.oauth.noProvider")}</p>
          ) : (
            <div className="space-y-2">
              {providers.map((p) => {
                const linked = links.find((l) => l.providerCode === p.code);
                return (
                  <div
                    key={p.id}
                    className="flex items-center gap-3 rounded-xl border border-border bg-surface-2/40 px-3 py-2"
                  >
                    <span className="flex-1 truncate text-sm">{p.displayName}</span>
                    {linked ? (
                      <>
                        <span className="text-xs text-muted">
                          {linked.externalName ?? linked.externalId}
                        </span>
                        <Button
                          size="sm"
                          variant="ghost"
                          onClick={() => void unlink(linked)}
                          className="text-danger hover:bg-danger/10"
                        >
                          {t("sec.oauth.unlink")}
                        </Button>
                      </>
                    ) : (
                      <Button
                        size="sm"
                        variant="ghost"
                        onClick={() => void startOAuth(p.code)}
                      >
                        {t("sec.oauth.bind")}
                      </Button>
                    )}
                  </div>
                );
              })}
            </div>
          )}
        </section>
      </div>

      {/* 2FA 设置 Modal */}
      <Modal
        open={setupOpen && !!setupData}
        onClose={() => setSetupOpen(false)}
        title={t("sec.2fa.setup.title")}
        size="md"
        footer={
          <>
            <Button variant="ghost" onClick={() => setSetupOpen(false)}>
              {t("confirm.cancel")}
            </Button>
            <Button onClick={() => void confirmEnable()} disabled={otpCode.length !== 6}>
              {t("sec.2fa.setup.confirm")}
            </Button>
          </>
        }
      >
        {setupData && (
          <div className="space-y-3">
            <p className="text-xs text-muted">{t("sec.2fa.setup.scan")}</p>
            {setupData.qrDataUrl && (
              <img
                src={setupData.qrDataUrl}
                alt="TOTP QR"
                className="mx-auto h-44 w-44 rounded-xl border border-border bg-white p-2"
              />
            )}
            <div className="rounded-xl border border-border bg-surface-2/60 p-3 text-center font-mono text-xs">
              {setupData.secret}
            </div>
            <TextField
              label={t("sec.2fa.setup.codeLabel")}
              value={otpCode}
              onChange={(e) => setOtpCode(e.target.value.replace(/\D/g, "").slice(0, 6))}
              placeholder="123456"
              autoFocus
            />
            <details>
              <summary className="cursor-pointer text-xs text-warning">
                {t("sec.2fa.setup.recovery")}
              </summary>
              <div className="mt-2 grid grid-cols-2 gap-1 rounded-xl border border-warning/30 bg-warning/5 p-3 font-mono text-[11px]">
                {setupData.recoveryCodes.map((c) => (
                  <div key={c}>{c}</div>
                ))}
              </div>
            </details>
          </div>
        )}
      </Modal>
    </div>
  );
}

function b64urlToBytes(s: string): Uint8Array {
  const pad = s.length % 4 === 0 ? "" : "=".repeat(4 - (s.length % 4));
  const b64 = (s + pad).replace(/-/g, "+").replace(/_/g, "/");
  const raw = atob(b64);
  const out = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i++) out[i] = raw.charCodeAt(i);
  return out;
}

function bytesToB64Url(bytes: Uint8Array): string {
  let str = "";
  for (let i = 0; i < bytes.length; i++) str += String.fromCharCode(bytes[i]);
  return btoa(str).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
