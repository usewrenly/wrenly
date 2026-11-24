"use client";
// Presentational grid card and table row for saved provider connections with a shared compact action menu.
import {
  CpuIcon,
  GlobeIcon,
  ImageIcon,
  MoreHorizontalIcon,
  PencilIcon,
  PowerIcon,
  SlidersHorizontalIcon,
  Trash2Icon,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import type { ProviderConnection } from "@/lib/models/provider-settings";
import type { ProviderDialogTab } from "./provider-connection-dialog";

function ConnectionActionsMenu({
  connection,
  busy,
  onEdit,
  onToggleEnabled,
  onRequestRemove,
}: {
  connection: ProviderConnection;
  busy: boolean;
  onEdit: (tab: ProviderDialogTab) => void;
  onToggleEnabled: () => void;
  onRequestRemove: () => void;
}): React.JSX.Element {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        render={
          <Button
            type="button"
            variant="ghost"
            size="icon-sm"
            disabled={busy}
            aria-label={`Actions for ${connection.label}`}
          />
        }
      >
        <MoreHorizontalIcon size={16} aria-hidden="true" />
      </DropdownMenuTrigger>
      <DropdownMenuContent
        align="end"
        className="w-44 bg-[var(--color-surface)] text-[var(--color-text-1)] ring-[var(--color-border-2)]"
      >
        <DropdownMenuItem onClick={() => onEdit("models")}>
          <SlidersHorizontalIcon size={14} aria-hidden="true" />
          Models &amp; default
        </DropdownMenuItem>
        <DropdownMenuItem onClick={() => onEdit("general")}>
          <PencilIcon size={14} aria-hidden="true" />
          Edit settings
        </DropdownMenuItem>
        <DropdownMenuItem onClick={() => onEdit("images")}>
          <ImageIcon size={14} aria-hidden="true" />
          Image inputs
        </DropdownMenuItem>
        <DropdownMenuItem onClick={onToggleEnabled}>
          <PowerIcon size={14} aria-hidden="true" />
          {connection.enabled ? "Disable" : "Enable"}
        </DropdownMenuItem>
        <DropdownMenuSeparator />
        <DropdownMenuItem variant="destructive" onClick={onRequestRemove}>
          <Trash2Icon size={14} aria-hidden="true" />
          Remove
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

/** Renders one uncluttered saved provider connection card in a 2-column grid. */
export function ProviderConnectionCard({
  connection,
  defaultModel,
  busy,
  onEdit,
  onToggleEnabled,
  onRequestRemove,
}: {
  connection: ProviderConnection;
  defaultModel: string | null;
  busy: boolean;
  onEdit: (tab: ProviderDialogTab) => void;
  onToggleEnabled: () => void;
  onRequestRemove: () => void;
}): React.JSX.Element {
  const boundProjectCount = connection.boundProjectCount ?? 0;
  return (
    <article
      className="provider-grid-card"
      data-enabled={connection.enabled}
      data-default={Boolean(defaultModel)}
    >
      <div className="provider-grid-card-top">
        <div className="flex min-w-0 items-center gap-2.5">
          <span className="model-provider-icon" aria-hidden="true">
            {connection.kind === "local" ? (
              <CpuIcon size={16} />
            ) : (
              <GlobeIcon size={16} />
            )}
          </span>
          <div className="min-w-0">
            <h3 className="truncate text-sm font-semibold text-[var(--color-text-1)]">
              {connection.label}
            </h3>
            <p className="text-xs text-[var(--color-text-3)]">
              {connection.kind === "local" ? "Local" : "Hosted"} ·{" "}
              {connection.tokenConfigured ? "Token saved" : "No token"}
            </p>
          </div>
        </div>
        <div className="flex shrink-0 items-center gap-1.5">
          <span
            className="provider-saved-badge"
            data-state={connection.enabled ? "enabled" : "disabled"}
          >
            {connection.enabled ? "Enabled" : "Disabled"}
          </span>
          <ConnectionActionsMenu
            connection={connection}
            busy={busy}
            onEdit={onEdit}
            onToggleEnabled={onToggleEnabled}
            onRequestRemove={onRequestRemove}
          />
        </div>
      </div>

      <p
        className="truncate font-mono text-xs text-[var(--color-text-2)]"
        title={connection.endpoint}
      >
        {connection.endpoint}
      </p>

      <div className="provider-grid-card-footer">
        <div className="flex min-w-0 flex-wrap items-center gap-1.5">
          {defaultModel ? (
            <span
              className="provider-saved-badge max-w-full"
              data-default="true"
              title={defaultModel}
            >
              <span className="truncate">
                Default: <code>{defaultModel}</code>
              </span>
            </span>
          ) : (
            <span className="text-xs text-[var(--color-text-3)]">
              No default model
            </span>
          )}
          {boundProjectCount > 0 && (
            <span className="provider-saved-badge">
              {boundProjectCount} bound{" "}
              {boundProjectCount === 1 ? "project" : "projects"}
            </span>
          )}
        </div>
        <Button
          type="button"
          variant="outline"
          size="xs"
          disabled={busy}
          onClick={() => onEdit("models")}
        >
          Models
        </Button>
      </div>
    </article>
  );
}

/** Renders one compact, overflow-free table row with a single menu trigger. */
export function ProviderConnectionTableRow({
  connection,
  defaultModel,
  busy,
  onEdit,
  onToggleEnabled,
  onRequestRemove,
}: {
  connection: ProviderConnection;
  defaultModel: string | null;
  busy: boolean;
  onEdit: (tab: ProviderDialogTab) => void;
  onToggleEnabled: () => void;
  onRequestRemove: () => void;
}): React.JSX.Element {
  const boundProjectCount = connection.boundProjectCount ?? 0;
  return (
    <tr className="provider-table-row">
      <td>
        <div className="flex min-w-0 items-center gap-2.5">
          {connection.kind === "local" ? (
            <CpuIcon
              size={15}
              className="shrink-0 text-[var(--color-text-2)]"
              aria-hidden="true"
            />
          ) : (
            <GlobeIcon
              size={15}
              className="shrink-0 text-[var(--color-text-2)]"
              aria-hidden="true"
            />
          )}
          <div className="min-w-0">
            <p className="truncate font-medium text-[var(--color-text-1)]">
              {connection.label}
            </p>
            {defaultModel && (
              <p
                className="truncate font-mono text-[11px] text-[var(--color-text-3)]"
                title={defaultModel}
              >
                Default: {defaultModel}
              </p>
            )}
          </div>
        </div>
      </td>
      <td className="whitespace-nowrap text-xs text-[var(--color-text-2)]">
        {connection.kind === "local" ? "Local" : "Hosted"}
      </td>
      <td>
        <span
          className="block truncate font-mono text-xs text-[var(--color-text-2)]"
          title={connection.endpoint}
        >
          {connection.endpoint}
        </span>
      </td>
      <td>
        <div className="flex flex-wrap items-center gap-1.5">
          <span
            className="provider-saved-badge"
            data-state={connection.enabled ? "enabled" : "disabled"}
          >
            {connection.enabled ? "Enabled" : "Disabled"}
          </span>
          {boundProjectCount > 0 && (
            <span className="provider-saved-badge">
              {boundProjectCount}{" "}
              {boundProjectCount === 1 ? "project" : "projects"}
            </span>
          )}
        </div>
      </td>
      <td className="text-right">
        <div className="inline-flex justify-end">
          <ConnectionActionsMenu
            connection={connection}
            busy={busy}
            onEdit={onEdit}
            onToggleEnabled={onToggleEnabled}
            onRequestRemove={onRequestRemove}
          />
        </div>
      </td>
    </tr>
  );
}
