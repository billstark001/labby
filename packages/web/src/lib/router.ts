import { signal } from "@preact/signals";
import { useEffect } from "preact/hooks";

type EmailTaskEditRoute = '/email-tasks/edit' | `/email-tasks/edit/${string}`;

export type AppRoute = '/login' | '/schedule' | '/persons' | '/keywords' | '/email-tasks' | EmailTaskEditRoute | '/graph' | '/settings';

export function normalizePath(rawHash: string): string {
  // Strip one or more leading '#' characters, not just one
  const stripped = rawHash.replace(/^#+/, "");
  if (!stripped || stripped === "/") return "/schedule";
  return stripped.startsWith("/") ? stripped : `/${stripped}`;
}

function getCurrentPath(): string {
  if (typeof window === "undefined") return "/schedule";
  return normalizePath(window.location.hash);
}

const route = signal<AppRoute>(getCurrentPath() as AppRoute);

export function navigate(path: AppRoute | string): void {
  const normalized = normalizePath(path) as AppRoute;
  const targetHash = `#${normalized}`;

  if (window.location.hash === targetHash) {
    // URL is already correct; just ensure the signal is in sync
    if (route.value !== normalized) {
      route.value = normalized;
    }
    return;
  }

  window.location.hash = targetHash;
}

export function useSyncRoute(): void {
  useEffect(() => {
    const syncRoute = () => {
      const normalized = normalizePath(window.location.hash);
      const targetHash = `#${normalized}`;

      // Silently rewrite non-canonical hashes (e.g. missing leading slash)
      // using replaceState so we don't fire a second 'hashchange' event
      if (window.location.hash !== targetHash) {
        const canonicalUrl =
          window.location.href.replace(/#.*$/, "") + targetHash;
        window.history.replaceState(null, "", canonicalUrl);
      }

      // Only write to the signal when the value actually changes
      if (route.value !== normalized) {
        route.value = normalized as AppRoute;
      }
    };

    syncRoute();
    window.addEventListener("hashchange", syncRoute);
    return () => window.removeEventListener("hashchange", syncRoute);
  }, []);
}

export function useRoute(): AppRoute {
  return route.value;
}