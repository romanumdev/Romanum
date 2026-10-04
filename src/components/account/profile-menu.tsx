"use client";

import Link from "next/link";
import { useId, useRef, useState, type KeyboardEvent, type ReactNode } from "react";
import { Gamepad2, LogIn, LogOut, Settings, X } from "lucide-react";
import { Avatar } from "./avatar";
import { Coin } from "../coin";
import { TOOL_FEE_CREDITS } from "@/lib/credits/tool-pricing";

const FOCUS = "outline-offset-2 focus-visible:outline-2 focus-visible:outline-fg/70";
const ITEM = `flex min-h-10 w-full items-center gap-3 rounded-lg px-3 text-left text-sm text-fg hover:bg-surface-hover focus-visible:bg-surface-hover ${FOCUS}`;

export type ProfileAccount = { displayName: string; username: string; pictureUrl: string | null };

export function ProfileMenu({ account, credits, signInAvailable, children, className, onNavigate }: {
  account: ProfileAccount | null;
  credits: number | null | undefined;
  signInAvailable: boolean;
  children: ReactNode;
  className: string;
  onNavigate: () => void;
}) {
  const trigger = useRef<HTMLButtonElement>(null);
  const menu = useRef<HTMLDivElement>(null);
  const settings = useRef<HTMLDialogElement>(null);
  // Desktop navigation and the closed mobile drawer coexist; their popovers and
  // settings dialogs need distinct targets and accessible heading references.
  const id = useId();
  const menuId = `${id}-account-menu`;
  const settingsHeadingId = `${id}-settings-heading`;
  const [open, setOpen] = useState(false);
  const balance = typeof credits === "number" ? credits.toLocaleString("en-US") : credits === null ? "Unavailable" : "…";

  function closeMenu() {
    menu.current?.hidePopover();
  }

  function navigate() {
    closeMenu();
    settings.current?.close();
    onNavigate();
  }

  function showMenu(last = false) {
    const popup = menu.current;
    const button = trigger.current;
    if (!popup || !button) return;
    const rect = button.getBoundingClientRect();
    // Native popovers live in the top layer, so the scrolling sidebar cannot clip the menu.
    popup.style.left = `${Math.max(8, Math.min(rect.left, window.innerWidth - 280))}px`;
    popup.style.bottom = `${Math.max(8, window.innerHeight - rect.top + 8)}px`;
    popup.showPopover();
    const items = popup.querySelectorAll<HTMLElement>('[role="menuitem"]');
    (last ? items[items.length - 1] : items[0])?.focus();
  }

  function menuKeys(event: KeyboardEvent<HTMLDivElement>) {
    const items = Array.from(event.currentTarget.querySelectorAll<HTMLElement>('[role="menuitem"]'));
    const index = items.indexOf(document.activeElement as HTMLElement);
    if (["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) {
      event.preventDefault();
      const next = event.key === "Home" ? 0 : event.key === "End" ? items.length - 1 :
        (index + (event.key === "ArrowDown" ? 1 : -1) + items.length) % items.length;
      items[next]?.focus();
    } else if (event.key === "Escape") {
      event.preventDefault();
      event.stopPropagation();
      closeMenu();
      trigger.current?.focus();
    } else if (event.key === "Tab") {
      closeMenu();
      trigger.current?.focus();
    }
  }

  function openSettings() {
    closeMenu();
    settings.current?.showModal();
  }

  return (
    <>
      <button
        ref={trigger}
        type="button"
        aria-label="Account menu"
        aria-haspopup="menu"
        aria-expanded={open}
        aria-controls={menuId}
        title="Account menu"
        className={className}
        onClick={() => open ? closeMenu() : showMenu()}
        onKeyDown={(event) => {
          if (event.key === "ArrowDown" || event.key === "ArrowUp") {
            event.preventDefault();
            showMenu(event.key === "ArrowUp");
          }
        }}
      >
        {children}
      </button>

      <div
        ref={menu}
        id={menuId}
        popover="auto"
        role="menu"
        aria-label="Account"
        onToggle={(event) => setOpen(event.newState === "open")}
        onKeyDown={menuKeys}
        className="fixed top-auto right-auto m-0 max-h-[calc(100dvh-6rem)] w-68 max-w-[calc(100vw-1rem)] overflow-y-auto rounded-2xl border border-line bg-surface p-1.5 text-fg shadow-xl"
      >
        <div role="presentation" className="flex items-center gap-3 px-3 py-3">
          <Avatar url={account?.pictureUrl} />
          <div className="min-w-0">
            <p className="truncate text-sm font-medium">{account?.displayName ?? "Guest"}</p>
            {account && <p className="truncate text-xs text-fg-muted">@{account.username}</p>}
          </div>
        </div>
        <div role="separator" className="mx-3 border-t border-line" />
        <div role="presentation" className="flex min-h-11 items-center gap-3 px-3 text-sm">
          <Coin className="size-4 shrink-0 text-white" />
          <span>Credits</span>
          <span className="ml-auto text-fg-muted tabular-nums">{balance}</span>
        </div>
        <Link role="menuitem" tabIndex={-1} href="/profile#games" onClick={navigate} className={ITEM}>
          <Gamepad2 className="size-4 text-white" aria-hidden="true" />Your games
        </Link>
        <button role="menuitem" tabIndex={-1} type="button" onClick={openSettings} className={ITEM}>
          <Settings className="size-4 text-white" aria-hidden="true" />Settings
        </button>
        {account ? (
          <form action="/auth/sign-out" method="post" role="none">
            <button role="menuitem" tabIndex={-1} type="submit" className={ITEM}>
              <LogOut className="size-4 text-white" aria-hidden="true" />Sign out
            </button>
          </form>
        ) : signInAvailable && (
          <Link role="menuitem" tabIndex={-1} href="/profile" onClick={navigate} className={ITEM}>
            <LogIn className="size-4 text-white" aria-hidden="true" />Sign in
          </Link>
        )}
      </div>

      <dialog
        ref={settings}
        aria-labelledby={settingsHeadingId}
        onClose={() => trigger.current?.focus()}
        onClick={(event) => {
          if (event.target !== event.currentTarget) return;
          const rect = event.currentTarget.getBoundingClientRect();
          if (event.clientX < rect.left || event.clientX > rect.right || event.clientY < rect.top || event.clientY > rect.bottom) settings.current?.close();
        }}
        className="fixed inset-0 m-auto max-h-[calc(100dvh-2rem)] w-md max-w-[calc(100vw-2rem)] overflow-y-auto rounded-2xl border border-line bg-surface p-6 text-fg backdrop:bg-black/70"
      >
        <header className="mb-6 flex items-center justify-between gap-3">
          <h2 id={settingsHeadingId} className="text-lg font-semibold">Settings</h2>
          <button type="button" autoFocus aria-label="Close settings" onClick={() => settings.current?.close()} className={`grid size-8 place-items-center rounded-lg hover:bg-surface-hover ${FOCUS}`}>
            <X className="size-5 text-white" aria-hidden="true" />
          </button>
        </header>
        <div className="flex items-center gap-3">
          <Avatar url={account?.pictureUrl} className="size-10" />
          <div className="min-w-0 flex-1">
            <p className="truncate text-sm font-medium">{account?.displayName ?? "Guest"}</p>
            {account && <p className="truncate text-xs text-fg-muted">@{account.username}</p>}
          </div>
          <Link href="/profile" onClick={navigate} className={`rounded-lg border border-line px-3 py-2 text-sm hover:bg-surface-hover ${FOCUS}`}>Profile</Link>
        </div>
        <dl className="mt-5 border-t border-line text-sm">
          <div className="flex items-center justify-between gap-4 py-4">
            <dt>Credits</dt>
            <dd className="flex items-center gap-2 tabular-nums"><Coin className="size-4 text-white" />{balance}</dd>
          </div>
        </dl>
        <p className="mb-4 text-xs leading-relaxed text-fg-muted">AI skill and stats calls: {TOOL_FEE_CREDITS} credits each, plus model usage.</p>
        <Link href="/profile/settings/games" onClick={navigate} className={`flex items-center justify-between gap-3 rounded-lg border border-line px-3 py-3 text-sm hover:bg-surface-hover ${FOCUS}`}>
          <span>Game data & sharing</span><span className="text-fg-muted">Manage</span>
        </Link>
        <Link href="/profile/data" onClick={navigate} className={`mt-2 flex items-center justify-between gap-3 rounded-lg border border-line px-3 py-3 text-sm hover:bg-surface-hover ${FOCUS}`}>
          <span>Your data</span><span className="text-fg-muted">Manage</span>
        </Link>
        <Link href="/privacy" onClick={navigate} className={`mt-4 inline-flex min-h-11 items-center text-xs text-fg-muted hover:text-fg ${FOCUS}`}>Privacy policy</Link>
      </dialog>
    </>
  );
}
