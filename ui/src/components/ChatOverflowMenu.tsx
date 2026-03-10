import React, { useEffect, useRef, useState } from "react";
import { Conversation, Link } from "../types";
import {
  getBrowserNotificationState,
  requestBrowserNotificationPermission,
  setChannelEnabled,
} from "../services/notifications";
import { applyTheme, setStoredTheme, ThemeMode } from "../services/theme";
import { Locale, TranslationKeys } from "../i18n";

const LANGUAGE_OPTIONS: { locale: Locale; flag: string; label: string }[] = [
  { locale: "en", flag: "🇺🇸", label: "English" },
  { locale: "ja", flag: "🇯🇵", label: "日本語" },
  { locale: "fr", flag: "🇫🇷", label: "Français" },
  { locale: "ru", flag: "🇷🇺", label: "Русский" },
  { locale: "es", flag: "🇪🇸", label: "Español" },
  { locale: "upgoer5", flag: "🚀", label: "Up-Goer Five" },
];

function LanguageDropdown({
  locale,
  setLocale,
  t,
}: {
  locale: Locale;
  setLocale: (locale: Locale) => void;
  t: (key: keyof TranslationKeys) => string;
}) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const current = LANGUAGE_OPTIONS.find((option) => option.locale === locale)!;

  useEffect(() => {
    if (!open) return;
    const handleClickOutside = (event: MouseEvent) => {
      if (ref.current && !ref.current.contains(event.target as Node)) {
        setOpen(false);
      }
    };
    document.addEventListener("mousedown", handleClickOutside);
    return () => document.removeEventListener("mousedown", handleClickOutside);
  }, [open]);

  return (
    <div className="language-dropdown" ref={ref}>
      <button
        className="language-dropdown-trigger"
        onClick={() => setOpen(!open)}
        aria-label={t("switchLanguage")}
      >
        <span className="language-dropdown-flag">{current.flag}</span>
        <span className="language-dropdown-text">{current.label}</span>
        <svg
          className={`language-dropdown-chevron${open ? " language-dropdown-chevron-open" : ""}`}
          width="12"
          height="12"
          viewBox="0 0 12 12"
          fill="none"
        >
          <path
            d="M3 4.5L6 7.5L9 4.5"
            stroke="currentColor"
            strokeWidth="1.5"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        </svg>
      </button>
      {open && (
        <div className="language-dropdown-menu">
          {LANGUAGE_OPTIONS.map((option) => (
            <button
              key={option.locale}
              className={`language-dropdown-item${option.locale === locale ? " language-dropdown-item-selected" : ""}`}
              onClick={() => {
                setLocale(option.locale);
                setOpen(false);
              }}
            >
              <span className="language-dropdown-flag">{option.flag}</span>
              <span>{option.label}</span>
              {option.locale === locale && (
                <svg
                  className="language-dropdown-check"
                  width="14"
                  height="14"
                  viewBox="0 0 14 14"
                  fill="none"
                >
                  <path
                    d="M3 7L6 10L11 4"
                    stroke="currentColor"
                    strokeWidth="2"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                  />
                </svg>
              )}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

interface ChatOverflowMenuProps {
  hasUpdate: boolean;
  conversationId: string | null;
  currentConversation?: Conversation;
  selectedCwd: string;
  terminalURL: string | null;
  links: Link[];
  themeMode: ThemeMode;
  markdownMode: "off" | "agent" | "all";
  locale: Locale;
  browserNotifsEnabled: boolean;
  setBrowserNotifsEnabled: React.Dispatch<React.SetStateAction<boolean>>;
  setThemeMode: React.Dispatch<React.SetStateAction<ThemeMode>>;
  setMarkdownMode: (mode: "off" | "agent" | "all") => void;
  setLocale: (locale: Locale) => void;
  onOpenVersionModal: () => void;
  onOpenDiffViewer: () => void;
  onArchiveConversation?: (conversationId: string) => Promise<void>;
  t: (key: keyof TranslationKeys) => string;
}

export default function ChatOverflowMenu({
  hasUpdate,
  conversationId,
  currentConversation,
  selectedCwd,
  terminalURL,
  links,
  themeMode,
  markdownMode,
  locale,
  browserNotifsEnabled,
  setBrowserNotifsEnabled,
  setThemeMode,
  setMarkdownMode,
  setLocale,
  onOpenVersionModal,
  onOpenDiffViewer,
  onArchiveConversation,
  t,
}: ChatOverflowMenuProps) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const handleClickOutside = (event: MouseEvent) => {
      if (ref.current && !ref.current.contains(event.target as Node)) {
        setOpen(false);
      }
    };
    document.addEventListener("mousedown", handleClickOutside);
    return () => document.removeEventListener("mousedown", handleClickOutside);
  }, [open]);

  return (
    <div ref={ref} style={{ position: "relative" }}>
      <button
        onClick={() => setOpen(!open)}
        className="btn-icon"
        aria-label={t("moreOptions")}
      >
        <svg fill="none" stroke="currentColor" viewBox="0 0 24 24">
          <path
            strokeLinecap="round"
            strokeLinejoin="round"
            strokeWidth={2}
            d="M12 5v.01M12 12v.01M12 19v.01M12 6a1 1 0 110-2 1 1 0 010 2zm0 7a1 1 0 110-2 1 1 0 010 2zm0 7a1 1 0 110-2 1 1 0 010 2z"
          />
        </svg>
        {hasUpdate && <span className="version-update-dot" />}
      </button>

      {open && (
        <div className="overflow-menu">
          {(currentConversation?.cwd || selectedCwd) && (
            <button
              onClick={() => {
                setOpen(false);
                onOpenDiffViewer();
              }}
              className="overflow-menu-item"
            >
              <svg
                fill="none"
                stroke="currentColor"
                viewBox="0 0 24 24"
                style={{ width: "1.25rem", height: "1.25rem", marginRight: "0.75rem" }}
              >
                <path
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  strokeWidth={2}
                  d="M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z"
                />
              </svg>
              {t("diffs")}
            </button>
          )}
          {terminalURL && (
            <button
              onClick={() => {
                setOpen(false);
                const cwd = currentConversation?.cwd || selectedCwd || "";
                const url = terminalURL.replace("WORKING_DIR", encodeURIComponent(cwd));
                window.open(url, "_blank");
              }}
              className="overflow-menu-item"
            >
              <svg
                fill="none"
                stroke="currentColor"
                viewBox="0 0 24 24"
                style={{ width: "1.25rem", height: "1.25rem", marginRight: "0.75rem" }}
              >
                <path
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  strokeWidth={2}
                  d="M8 9l3 3-3 3m5 0h3M5 20h14a2 2 0 002-2V6a2 2 0 00-2-2H5a2 2 0 00-2 2v12a2 2 0 002 2z"
                />
              </svg>
              {t("terminal")}
            </button>
          )}
          {links.map((link, index) => (
            <button
              key={index}
              onClick={() => {
                setOpen(false);
                window.open(link.url, "_blank");
              }}
              className="overflow-menu-item"
            >
              <svg
                fill="none"
                stroke="currentColor"
                viewBox="0 0 24 24"
                style={{ width: "1.25rem", height: "1.25rem", marginRight: "0.75rem" }}
              >
                <path
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  strokeWidth={2}
                  d={
                    link.icon_svg ||
                    "M10 6H6a2 2 0 00-2 2v10a2 2 0 002 2h10a2 2 0 002-2v-4M14 4h6m0 0v6m0-6L10 14"
                  }
                />
              </svg>
              {link.title}
            </button>
          ))}

          {conversationId && onArchiveConversation && !currentConversation?.archived && (
            <>
              <div className="overflow-menu-divider" />
              <button
                onClick={async () => {
                  setOpen(false);
                  try {
                    await onArchiveConversation(conversationId);
                  } catch (err) {
                    console.error("Failed to archive conversation:", err);
                  }
                }}
                className="overflow-menu-item"
              >
                <svg
                  fill="none"
                  stroke="currentColor"
                  viewBox="0 0 24 24"
                  style={{ width: "1.25rem", height: "1.25rem", marginRight: "0.75rem" }}
                >
                  <path
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    strokeWidth={2}
                    d="M5 8h14M8 8V6a4 4 0 118 0v2m-9 0v10a2 2 0 002 2h6a2 2 0 002-2V8"
                  />
                </svg>
                {t("archiveConversation")}
              </button>
            </>
          )}

          <div className="overflow-menu-divider" />
          <button
            onClick={() => {
              setOpen(false);
              onOpenVersionModal();
            }}
            className="overflow-menu-item"
          >
            <svg
              fill="none"
              stroke="currentColor"
              viewBox="0 0 24 24"
              style={{ width: "1.25rem", height: "1.25rem", marginRight: "0.75rem" }}
            >
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                strokeWidth={2}
                d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15"
              />
            </svg>
            {t("checkForNewVersion")}
            {hasUpdate && <span className="version-menu-dot" />}
          </button>

          <div className="overflow-menu-divider" />
          <div className="theme-toggle-row">
            {(["system", "light", "dark"] as ThemeMode[]).map((mode) => (
              <button
                key={mode}
                onClick={() => {
                  setThemeMode(mode);
                  setStoredTheme(mode);
                  applyTheme(mode);
                }}
                className={`theme-toggle-btn${themeMode === mode ? " theme-toggle-btn-selected" : ""}`}
                title={t(mode)}
              >
                {mode === "system" ? (
                  <svg fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path
                      strokeLinecap="round"
                      strokeLinejoin="round"
                      strokeWidth={2}
                      d="M9.75 17L9 20l-1 1h8l-1-1-.75-3M3 13h18M5 17h14a2 2 0 002-2V5a2 2 0 00-2-2H5a2 2 0 00-2 2v10a2 2 0 002 2z"
                    />
                  </svg>
                ) : mode === "light" ? (
                  <svg fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path
                      strokeLinecap="round"
                      strokeLinejoin="round"
                      strokeWidth={2}
                      d="M12 3v1m0 16v1m9-9h-1M4 12H3m15.364 6.364l-.707-.707M6.343 6.343l-.707-.707m12.728 0l-.707.707M6.343 17.657l-.707.707M16 12a4 4 0 11-8 0 4 4 0 018 0z"
                    />
                  </svg>
                ) : (
                  <svg fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path
                      strokeLinecap="round"
                      strokeLinejoin="round"
                      strokeWidth={2}
                      d="M20.354 15.354A9 9 0 018.646 3.646 9.003 9.003 0 0012 21a9.003 9.003 0 008.354-5.646z"
                    />
                  </svg>
                )}
              </button>
            ))}
          </div>

          {typeof Notification !== "undefined" && (
            <>
              <div className="overflow-menu-divider" />
              <div className="theme-toggle-row">
                <button
                  onClick={async () => {
                    if (browserNotifsEnabled) return;
                    const granted = await requestBrowserNotificationPermission();
                    if (granted) {
                      setBrowserNotifsEnabled(true);
                    }
                  }}
                  className={`theme-toggle-btn${browserNotifsEnabled ? " theme-toggle-btn-selected" : ""}`}
                  title={
                    getBrowserNotificationState() === "denied"
                      ? t("blockedByBrowser")
                      : t("enableNotifications")
                  }
                  disabled={getBrowserNotificationState() === "denied"}
                >
                  <svg fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path
                      strokeLinecap="round"
                      strokeLinejoin="round"
                      strokeWidth={2}
                      d="M15 17h5l-1.405-1.405A2.032 2.032 0 0118 14.158V11a6.002 6.002 0 00-4-5.659V5a2 2 0 10-4 0v.341C7.67 6.165 6 8.388 6 11v3.159c0 .538-.214 1.055-.595 1.436L4 17h5m6 0v1a3 3 0 11-6 0v-1m6 0H9"
                    />
                  </svg>
                </button>
                <button
                  onClick={() => {
                    if (!browserNotifsEnabled) return;
                    setChannelEnabled("browser", false);
                    setBrowserNotifsEnabled(false);
                  }}
                  className={`theme-toggle-btn${!browserNotifsEnabled ? " theme-toggle-btn-selected" : ""}`}
                  title={t("disableNotifications")}
                >
                  <svg fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path
                      strokeLinecap="round"
                      strokeLinejoin="round"
                      strokeWidth={2}
                      d="M5.586 15H4l1.405-1.405A2.032 2.032 0 006 12.158V9a6.002 6.002 0 014-5.659V3a2 2 0 114 0v.341c.588.17 1.14.432 1.636.772M15 17h-6v1a3 3 0 006 0v-1zM18 9a3 3 0 00-3-3M3 3l18 18"
                    />
                  </svg>
                </button>
              </div>
            </>
          )}

          <div className="overflow-menu-divider" />
          <div className="md-toggle-row">
            <div className="md-toggle-label">{t("markdown")}</div>
            <div className="md-toggle-buttons">
              {(["off", "agent", "all"] as const).map((mode) => (
                <button
                  key={mode}
                  onClick={() => setMarkdownMode(mode)}
                  className={`md-toggle-btn${markdownMode === mode ? " md-toggle-btn-selected" : ""}`}
                  title={
                    mode === "off"
                      ? t("showPlainText")
                      : mode === "agent"
                        ? t("renderMarkdownAgent")
                        : t("renderMarkdownAll")
                  }
                >
                  {t(mode)}
                </button>
              ))}
            </div>
          </div>

          <div className="overflow-menu-divider" />
          <div className="language-selector-row">
            <div className="md-toggle-label">
              {t("language")}{" "}
              <a
                href={`https://github.com/boldsoftware/shelley/issues/new?labels=translation&title=${encodeURIComponent("Translation issue: ")}&body=${encodeURIComponent("**Language:** \n**Where in the UI:** \n**Current text:** \n**Suggested text:** \n")}`}
                target="_blank"
                rel="noopener noreferrer"
                className="report-bug-link"
                onClick={(event) => event.stopPropagation()}
              >
                [{t("reportBug")}]
              </a>
            </div>
            <LanguageDropdown locale={locale} setLocale={setLocale} t={t} />
          </div>
        </div>
      )}
    </div>
  );
}
