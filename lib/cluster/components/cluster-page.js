"use client";
import { Fragment, jsx, jsxs } from "react/jsx-runtime";
import { useState, useEffect, useRef } from "react";
import { DndContext, closestCenter, PointerSensor, KeyboardSensor, useSensor, useSensors } from "@dnd-kit/core";
import { SortableContext, horizontalListSortingStrategy, useSortable, arrayMove } from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import { PageLayout } from "../../chat/components/page-layout.js";
import { PlusIcon, TrashIcon, PencilIcon, CopyIcon, CheckIcon } from "../../chat/components/icons.js";
import {
  getCluster,
  renameCluster,
  deleteCluster,
  updateClusterSystemPrompt,
  updateClusterFolders,
  createClusterRoleAction,
  updateClusterRoleAction,
  deleteClusterRoleAction,
  triggerRoleManually,
  toggleCluster,
  stopRoleAction,
  getClusterStatus,
  reorderClusterRolesAction
} from "../actions.js";
import { ConfirmDialog } from "../../chat/components/ui/confirm-dialog.js";
function ClusterPage({ session, clusterId, roleId }) {
  const [cluster, setCluster] = useState(null);
  const [loading, setLoading] = useState(true);
  const [editingName, setEditingName] = useState(false);
  const [nameValue, setNameValue] = useState("");
  const [systemPromptValue, setSystemPromptValue] = useState("");
  const [roleStatus, setRoleStatus] = useState({});
  const [clusterBusy, setClusterBusy] = useState(false);
  const [foldersValue, setFoldersValue] = useState("");
  const [confirmDeleteCluster, setConfirmDeleteCluster] = useState(false);
  const [showPlaceholders, setShowPlaceholders] = useState(false);
  const [activeTab, setActiveTab] = useState(roleId || "general");
  const nameRef = useRef(null);
  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 5 } }),
    useSensor(KeyboardSensor)
  );
  const updateUrl = (tab) => {
    const url = tab === "general" ? `/cluster/${clusterId}` : `/cluster/${clusterId}/role/${tab}`;
    window.history.replaceState(null, "", url);
  };
  const switchTab = (tab) => {
    setActiveTab(tab);
    updateUrl(tab);
  };
  const load = async () => {
    try {
      const result = await getCluster(clusterId);
      setCluster(result);
      setNameValue(result?.name || "");
      setSystemPromptValue(result?.systemPrompt || "");
      setFoldersValue(result?.folders ? result.folders.join(", ") : "");
    } catch (err) {
      console.error("Failed to load cluster:", err);
    } finally {
      setLoading(false);
    }
  };
  useEffect(() => {
    load();
  }, [clusterId]);
  useEffect(() => {
    if (!cluster?.roles?.length) return;
    let active = true;
    const poll = async () => {
      try {
        const status = await getClusterStatus(clusterId);
        if (active) setRoleStatus(status);
      } catch {
      }
    };
    poll();
    const interval = setInterval(poll, 1e4);
    return () => {
      active = false;
      clearInterval(interval);
    };
  }, [cluster?.roles?.length, clusterId]);
  useEffect(() => {
    if (editingName && nameRef.current) {
      nameRef.current.focus();
      nameRef.current.select();
    }
  }, [editingName]);
  const saveName = async () => {
    const trimmed = nameValue.trim();
    if (trimmed && trimmed !== cluster.name) {
      await renameCluster(clusterId, trimmed);
      setCluster((prev) => ({ ...prev, name: trimmed }));
    }
    setEditingName(false);
  };
  const saveSystemPrompt = async () => {
    if (systemPromptValue !== (cluster.systemPrompt || "")) {
      await updateClusterSystemPrompt(clusterId, systemPromptValue);
      setCluster((prev) => ({ ...prev, systemPrompt: systemPromptValue }));
    }
  };
  const saveFolders = async () => {
    const folders = foldersValue.split(",").map((s) => s.trim()).filter(Boolean);
    const current = cluster.folders || [];
    if (JSON.stringify(folders) !== JSON.stringify(current)) {
      await updateClusterFolders(clusterId, folders.length ? folders : null);
      setCluster((prev) => ({ ...prev, folders: folders.length ? folders : null }));
    }
  };
  const handleAddRole = async () => {
    const { success, role } = await createClusterRoleAction(clusterId, "New Role");
    if (success) {
      setCluster((prev) => ({
        ...prev,
        roles: [...prev.roles || [], { ...role, triggerConfig: null, folders: null }]
      }));
      switchTab(role.id);
    }
  };
  const handleUpdateRole = async (roleId2, updates) => {
    setCluster((prev) => ({
      ...prev,
      roles: prev.roles.map(
        (r) => r.id === roleId2 ? { ...r, ...updates } : r
      )
    }));
    await updateClusterRoleAction(roleId2, updates);
  };
  const handleDeleteRole = async (deletedRoleId) => {
    await deleteClusterRoleAction(deletedRoleId);
    setCluster((prev) => ({
      ...prev,
      roles: prev.roles.filter((r) => r.id !== deletedRoleId)
    }));
    switchTab("general");
  };
  const handleToggleCluster = async () => {
    setClusterBusy(true);
    try {
      const result = await toggleCluster(clusterId);
      if (result.success) {
        setCluster((prev) => ({ ...prev, enabled: result.enabled }));
      }
    } catch (err) {
      console.error("Failed to toggle cluster:", err);
    } finally {
      setClusterBusy(false);
      try {
        const status = await getClusterStatus(clusterId);
        setRoleStatus(status);
      } catch {
      }
    }
  };
  const handleDeleteCluster = async () => {
    const { success } = await deleteCluster(clusterId);
    if (success) {
      window.location.href = "/clusters/list";
    }
  };
  const handleDragEnd = (event) => {
    const { active, over } = event;
    if (!over || active.id === over.id) return;
    const roles = cluster.roles || [];
    const oldIndex = roles.findIndex((r) => r.id === active.id);
    const newIndex = roles.findIndex((r) => r.id === over.id);
    if (oldIndex === -1 || newIndex === -1) return;
    const reordered = arrayMove(roles, oldIndex, newIndex);
    setCluster((prev) => ({ ...prev, roles: reordered }));
    reorderClusterRolesAction(clusterId, reordered.map((r) => r.id));
  };
  const totalRunning = Object.values(roleStatus).reduce((sum, s) => sum + (s.running || 0), 0);
  const totalCapacity = (cluster?.roles || []).reduce((sum, r) => sum + (r.maxConcurrency || 1), 0);
  const totalRoles = cluster?.roles?.length || 0;
  if (loading) {
    return /* @__PURE__ */ jsx(PageLayout, { session, children: /* @__PURE__ */ jsxs("div", { className: "flex flex-col gap-4", children: [
      /* @__PURE__ */ jsx("div", { className: "h-8 w-48 animate-pulse rounded-md bg-border/50" }),
      /* @__PURE__ */ jsx("div", { className: "h-40 animate-pulse rounded-md bg-border/50" })
    ] }) });
  }
  if (!cluster) {
    return /* @__PURE__ */ jsx(PageLayout, { session, children: /* @__PURE__ */ jsx("p", { className: "text-sm text-muted-foreground py-8 text-center", children: "Cluster not found." }) });
  }
  const activeRole = activeTab !== "general" ? cluster.roles?.find((r) => r.id === activeTab) : null;
  if (activeTab !== "general" && !activeRole) {
    switchTab("general");
  }
  return /* @__PURE__ */ jsxs(PageLayout, { session, children: [
    /* @__PURE__ */ jsxs("div", { className: "flex items-center flex-wrap gap-2 md:gap-3 mb-4", children: [
      /* @__PURE__ */ jsx(
        "a",
        {
          href: "/clusters/list",
          className: "text-xs md:text-sm text-muted-foreground hover:text-foreground",
          children: "Clusters"
        }
      ),
      /* @__PURE__ */ jsx("span", { className: "text-muted-foreground", children: "/" }),
      editingName ? /* @__PURE__ */ jsx(
        "input",
        {
          ref: nameRef,
          type: "text",
          value: nameValue,
          onChange: (e) => setNameValue(e.target.value),
          onKeyDown: (e) => {
            if (e.key === "Enter") saveName();
            if (e.key === "Escape") {
              setEditingName(false);
              setNameValue(cluster.name);
            }
          },
          onBlur: saveName,
          className: "text-lg md:text-2xl font-semibold bg-background border border-input rounded px-2 py-0.5 focus:outline-none focus:ring-2 focus:ring-ring"
        }
      ) : /* @__PURE__ */ jsx(
        "h1",
        {
          className: "text-lg md:text-2xl font-semibold cursor-pointer hover:text-muted-foreground truncate",
          onClick: () => setEditingName(true),
          title: "Click to rename",
          children: cluster.name
        }
      ),
      !editingName && /* @__PURE__ */ jsxs(Fragment, { children: [
        /* @__PURE__ */ jsx(
          "button",
          {
            onClick: () => setEditingName(true),
            className: "text-muted-foreground hover:text-foreground p-1 rounded-md hover:bg-muted",
            children: /* @__PURE__ */ jsx(PencilIcon, { size: 16 })
          }
        ),
        /* @__PURE__ */ jsx(
          "a",
          {
            href: `/cluster/${clusterId}/console`,
            className: "ml-2 md:ml-4 px-3 py-1 rounded-md text-xs bg-muted text-muted-foreground hover:bg-muted/70 hover:text-foreground transition-colors",
            children: "Console"
          }
        ),
        /* @__PURE__ */ jsx(
          "a",
          {
            href: `/cluster/${clusterId}/logs`,
            className: "px-3 py-1 rounded-md text-xs bg-muted text-muted-foreground hover:bg-muted/70 hover:text-foreground transition-colors",
            children: "Logs"
          }
        )
      ] })
    ] }),
    /* @__PURE__ */ jsx(
      ConfirmDialog,
      {
        open: confirmDeleteCluster,
        title: "Delete cluster?",
        description: "This will permanently delete this cluster and all its roles.",
        confirmLabel: "Delete",
        onConfirm: () => {
          setConfirmDeleteCluster(false);
          handleDeleteCluster();
        },
        onCancel: () => setConfirmDeleteCluster(false)
      }
    ),
    /* @__PURE__ */ jsx(PlaceholderDialog, { open: showPlaceholders, onClose: () => setShowPlaceholders(false) }),
    totalRoles > 0 && /* @__PURE__ */ jsx("div", { className: "flex items-center gap-3 mb-4", children: /* @__PURE__ */ jsxs(
      "button",
      {
        type: "button",
        onClick: handleToggleCluster,
        disabled: clusterBusy,
        className: "inline-flex items-center gap-2 group disabled:opacity-50",
        role: "switch",
        "aria-checked": !!cluster.enabled,
        "aria-label": "Toggle cluster",
        children: [
          clusterBusy && /* @__PURE__ */ jsxs("svg", { className: "animate-spin h-3.5 w-3.5 text-muted-foreground", xmlns: "http://www.w3.org/2000/svg", fill: "none", viewBox: "0 0 24 24", children: [
            /* @__PURE__ */ jsx("circle", { className: "opacity-25", cx: "12", cy: "12", r: "10", stroke: "currentColor", strokeWidth: "4" }),
            /* @__PURE__ */ jsx("path", { className: "opacity-75", fill: "currentColor", d: "M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" })
          ] }),
          /* @__PURE__ */ jsx(
            "span",
            {
              className: `relative inline-flex h-5 w-9 shrink-0 rounded-full transition-colors duration-200 ${cluster.enabled ? "bg-primary" : "bg-muted-foreground/30"}`,
              children: /* @__PURE__ */ jsx(
                "span",
                {
                  className: `absolute top-0.5 left-0.5 h-4 w-4 rounded-full bg-white shadow-sm transition-transform duration-200 ${cluster.enabled ? "translate-x-4" : ""}`
                }
              )
            }
          ),
          /* @__PURE__ */ jsx("span", { className: `text-sm font-medium transition-colors ${cluster.enabled ? "text-foreground" : "text-muted-foreground group-hover:text-foreground"}`, children: cluster.enabled ? "On" : "Off" })
        ]
      }
    ) }),
    /* @__PURE__ */ jsxs("div", { className: "flex gap-1 border-b border-border mb-6 overflow-x-auto", children: [
      /* @__PURE__ */ jsx(
        "button",
        {
          onClick: () => switchTab("general"),
          className: `inline-flex items-center gap-2 px-3 py-2 min-h-[44px] shrink-0 text-sm font-medium border-b-2 transition-colors ${activeTab === "general" ? "border-foreground text-foreground" : "border-transparent text-muted-foreground hover:text-foreground hover:border-border"}`,
          children: "General"
        }
      ),
      /* @__PURE__ */ jsx(DndContext, { sensors, collisionDetection: closestCenter, onDragEnd: handleDragEnd, children: /* @__PURE__ */ jsx(SortableContext, { items: (cluster.roles || []).map((r) => r.id), strategy: horizontalListSortingStrategy, children: (cluster.roles || []).map((role) => /* @__PURE__ */ jsx(
        SortableTab,
        {
          role,
          isActive: activeTab === role.id,
          onClick: () => switchTab(role.id)
        },
        role.id
      )) }) }),
      /* @__PURE__ */ jsxs(
        "button",
        {
          onClick: handleAddRole,
          className: "inline-flex items-center gap-2 px-3 py-2 min-h-[44px] shrink-0 text-sm font-medium border-b-2 border-transparent text-muted-foreground hover:text-foreground hover:border-border transition-colors",
          children: [
            /* @__PURE__ */ jsx(PlusIcon, { size: 14 }),
            "New Role"
          ]
        }
      )
    ] }),
    activeTab === "general" ? /* @__PURE__ */ jsxs("div", { children: [
      /* @__PURE__ */ jsxs("div", { className: "mb-6 border-b border-border pb-6", children: [
        /* @__PURE__ */ jsx("label", { className: "text-sm font-medium block mb-1", children: "System Prompt" }),
        /* @__PURE__ */ jsx("p", { className: "text-xs text-muted-foreground mb-2", children: "Define the cluster's mission, goals, and shared instructions. This is prepended to every role's prompt along with the workspace structure." }),
        /* @__PURE__ */ jsx(
          "textarea",
          {
            value: systemPromptValue,
            onChange: (e) => setSystemPromptValue(e.target.value),
            onBlur: saveSystemPrompt,
            placeholder: "Enter shared instructions for all roles...",
            rows: 8,
            className: "w-full text-xs bg-background border border-input rounded-md px-3 py-2 focus:outline-none focus:ring-2 focus:ring-ring resize-y font-mono"
          }
        ),
        /* @__PURE__ */ jsxs("div", { className: "flex items-center gap-2 mt-1.5", children: [
          /* @__PURE__ */ jsxs("span", { className: "text-xs text-muted-foreground", children: [
            "Use ",
            /* @__PURE__ */ jsx("code", { className: "font-mono bg-muted px-1 rounded", children: "{{PLACEHOLDERS}}" }),
            " for dynamic values."
          ] }),
          /* @__PURE__ */ jsx(
            "button",
            {
              type: "button",
              onClick: () => setShowPlaceholders(true),
              className: "text-xs text-primary underline underline-offset-2 hover:text-primary/80",
              children: "View all \u2192"
            }
          )
        ] })
      ] }),
      /* @__PURE__ */ jsxs("div", { className: "mb-6", children: [
        /* @__PURE__ */ jsx("label", { className: "text-sm font-medium block mb-1", children: "Folders" }),
        /* @__PURE__ */ jsx("p", { className: "text-xs text-muted-foreground mb-2", children: "Comma-separated folder names created under shared/ for all roles." }),
        /* @__PURE__ */ jsx(
          "input",
          {
            type: "text",
            value: foldersValue,
            onChange: (e) => setFoldersValue(e.target.value),
            onBlur: saveFolders,
            onKeyDown: (e) => {
              if (e.key === "Enter") e.target.blur();
            },
            placeholder: "inbox, output, reports",
            className: "w-full text-sm bg-background border border-input rounded-md px-3 py-2 focus:outline-none focus:ring-2 focus:ring-ring font-mono"
          }
        )
      ] }),
      /* @__PURE__ */ jsx("div", { className: "pt-6 border-t border-border mt-6", children: /* @__PURE__ */ jsxs(
        "button",
        {
          onClick: () => setConfirmDeleteCluster(true),
          className: "inline-flex items-center gap-2 rounded-md px-3 py-2 text-sm font-medium text-destructive border border-destructive/30 hover:bg-destructive/10",
          children: [
            /* @__PURE__ */ jsx(TrashIcon, { size: 16 }),
            "Delete cluster"
          ]
        }
      ) })
    ] }) : activeRole ? /* @__PURE__ */ jsx(
      RoleTabContent,
      {
        role: activeRole,
        clusterId,
        status: roleStatus[activeRole.id],
        onUpdate: handleUpdateRole,
        onDelete: handleDeleteRole
      }
    ) : null
  ] });
}
function SortableTab({ role, isActive, onClick }) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({ id: role.id });
  const style = {
    transform: CSS.Transform.toString(transform),
    transition,
    opacity: isDragging ? 0.5 : 1
  };
  return /* @__PURE__ */ jsx(
    "button",
    {
      ref: setNodeRef,
      style,
      ...attributes,
      ...listeners,
      onClick,
      className: `inline-flex items-center gap-2 px-3 py-2 min-h-[44px] shrink-0 text-sm font-medium border-b-2 transition-colors cursor-grab active:cursor-grabbing ${isActive ? "border-foreground text-foreground" : "border-transparent text-muted-foreground hover:text-foreground hover:border-border"}`,
      children: role.roleName || "New Role"
    }
  );
}
function RoleTabContent({ role, clusterId, status, onUpdate, onDelete }) {
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [showPlaceholders, setShowPlaceholders] = useState(false);
  const [editingName, setEditingName] = useState(false);
  const shortId = role.id.replace(/-/g, "").slice(0, 8);
  const [nameValue, setNameValue] = useState(role.roleName || "New Role");
  const [rolePromptValue, setRolePromptValue] = useState(role.role || "");
  const [promptValue, setPromptValue] = useState(role.prompt || "Execute your role.");
  const [running, setRunning] = useState(false);
  const [stopping, setStopping] = useState(false);
  const [foldersValue, setFoldersValue] = useState(role.folders ? role.folders.join(", ") : "");
  const [maxConcurrency, setMaxConcurrency] = useState(role.maxConcurrency || 1);
  const [cleanupWorkerDir, setCleanupWorkerDir] = useState(!!role.cleanupWorkerDir);
  const nameRef = useRef(null);
  const tc = role.triggerConfig || {};
  const hasCron = !!(tc.cron && tc.cron.enabled);
  const hasFileWatch = !!(tc.file_watch && tc.file_watch.enabled);
  const [cronValue, setCronValue] = useState(tc.cron?.schedule || "");
  const [fileWatchValue, setFileWatchValue] = useState(tc.file_watch?.paths || "");
  const runningCount = status?.running || 0;
  const isRunning = runningCount > 0;
  useEffect(() => {
    setNameValue(role.roleName || "New Role");
    setRolePromptValue(role.role || "");
    setPromptValue(role.prompt || "Execute your role.");
    setFoldersValue(role.folders ? role.folders.join(", ") : "");
    setMaxConcurrency(role.maxConcurrency || 1);
    setCleanupWorkerDir(!!role.cleanupWorkerDir);
    const tc2 = role.triggerConfig || {};
    setCronValue(tc2.cron?.schedule || "");
    setFileWatchValue(tc2.file_watch?.paths || "");
    setEditingName(false);
    setConfirmDelete(false);
  }, [role.id]);
  useEffect(() => {
    if (editingName && nameRef.current) {
      nameRef.current.focus();
      nameRef.current.select();
    }
  }, [editingName]);
  const saveName = () => {
    const trimmed = nameValue.trim();
    if (trimmed && trimmed !== role.roleName) {
      onUpdate(role.id, { roleName: trimmed });
    }
    setEditingName(false);
  };
  const saveRolePrompt = () => {
    if (rolePromptValue !== (role.role || "")) {
      onUpdate(role.id, { role: rolePromptValue });
    }
  };
  const savePrompt = () => {
    if (promptValue !== (role.prompt || "Execute your role.")) {
      onUpdate(role.id, { prompt: promptValue });
    }
  };
  const buildConfig = (overrides) => {
    const next = { ...tc, ...overrides };
    if (next.cron && !next.cron.enabled) delete next.cron;
    if (next.file_watch && !next.file_watch.enabled) delete next.file_watch;
    return Object.keys(next).length ? next : null;
  };
  const toggleTrigger = (type) => {
    if (type === "cron") {
      if (hasCron) {
        onUpdate(role.id, { triggerConfig: buildConfig({ cron: { enabled: false } }) });
      } else {
        const schedule = cronValue || "*/5 * * * *";
        if (!cronValue) setCronValue(schedule);
        onUpdate(role.id, { triggerConfig: buildConfig({ cron: { enabled: true, schedule } }) });
      }
    } else if (type === "file_watch") {
      if (hasFileWatch) {
        onUpdate(role.id, { triggerConfig: buildConfig({ file_watch: { enabled: false } }) });
      } else {
        const paths = fileWatchValue || "";
        onUpdate(role.id, { triggerConfig: buildConfig({ file_watch: { enabled: true, paths } }) });
      }
    }
  };
  const saveCron = () => {
    const trimmed = cronValue.trim();
    if (hasCron && trimmed !== (tc.cron?.schedule || "")) {
      onUpdate(role.id, { triggerConfig: buildConfig({ cron: { enabled: true, schedule: trimmed } }) });
    }
  };
  const saveFileWatch = () => {
    const trimmed = fileWatchValue.trim();
    if (hasFileWatch && trimmed !== (tc.file_watch?.paths || "")) {
      onUpdate(role.id, { triggerConfig: buildConfig({ file_watch: { enabled: true, paths: trimmed } }) });
    }
  };
  const saveFolders = async () => {
    const folders = foldersValue.split(",").map((s) => s.trim()).filter(Boolean);
    const current = role.folders || [];
    if (JSON.stringify(folders) !== JSON.stringify(current)) {
      await onUpdate(role.id, { folders: folders.length ? folders : null });
    }
  };
  const saveMaxConcurrency = () => {
    const val = Math.max(1, parseInt(maxConcurrency, 10) || 1);
    setMaxConcurrency(val);
    if (val !== (role.maxConcurrency || 1)) {
      onUpdate(role.id, { maxConcurrency: val });
    }
  };
  const toggleCleanup = () => {
    const next = !cleanupWorkerDir;
    setCleanupWorkerDir(next);
    onUpdate(role.id, { cleanupWorkerDir: next ? 1 : 0 });
  };
  const handleRun = async () => {
    setRunning(true);
    try {
      await triggerRoleManually(role.id);
    } catch (err) {
      console.error("Failed to trigger role:", err);
    } finally {
      setRunning(false);
    }
  };
  const handleStop = async () => {
    setStopping(true);
    try {
      await stopRoleAction(role.id);
    } catch (err) {
      console.error("Failed to stop role:", err);
    } finally {
      setStopping(false);
    }
  };
  return /* @__PURE__ */ jsxs("div", { children: [
    /* @__PURE__ */ jsxs("div", { className: "flex flex-wrap items-center gap-3 mb-6", children: [
      /* @__PURE__ */ jsxs("div", { className: "flex items-center gap-2", children: [
        editingName ? /* @__PURE__ */ jsx(
          "input",
          {
            ref: nameRef,
            type: "text",
            value: nameValue,
            onChange: (e) => setNameValue(e.target.value),
            onKeyDown: (e) => {
              if (e.key === "Enter") saveName();
              if (e.key === "Escape") {
                setEditingName(false);
                setNameValue(role.roleName || "New Role");
              }
            },
            onBlur: saveName,
            className: "text-lg font-semibold bg-background border border-input rounded px-1.5 py-0.5 focus:outline-none focus:ring-2 focus:ring-ring w-full max-w-xs"
          }
        ) : /* @__PURE__ */ jsx("span", { className: "text-lg font-semibold truncate", children: role.roleName || "New Role" }),
        !editingName && /* @__PURE__ */ jsx(
          "button",
          {
            onClick: () => setEditingName(true),
            className: "text-muted-foreground hover:text-foreground p-1 rounded-md hover:bg-muted",
            children: /* @__PURE__ */ jsx(PencilIcon, { size: 14 })
          }
        )
      ] }),
      /* @__PURE__ */ jsx("div", { className: "flex items-center justify-center px-2 h-6 rounded bg-muted text-xs font-mono font-medium shrink-0", children: shortId }),
      /* @__PURE__ */ jsxs("div", { className: "flex items-center gap-2 ml-auto", children: [
        /* @__PURE__ */ jsx(
          "button",
          {
            onClick: handleRun,
            disabled: running,
            className: "rounded-md px-2.5 py-1.5 text-xs font-medium border border-input hover:bg-muted disabled:opacity-50 shrink-0",
            children: running ? "Starting..." : "Run"
          }
        ),
        isRunning && /* @__PURE__ */ jsx(
          "button",
          {
            onClick: handleStop,
            disabled: stopping,
            className: "rounded-md px-2.5 py-1.5 text-xs font-medium border border-input hover:bg-muted disabled:opacity-50 shrink-0",
            children: stopping ? "Stopping..." : "Stop All"
          }
        )
      ] })
    ] }),
    /* @__PURE__ */ jsxs("div", { className: "mb-6", children: [
      /* @__PURE__ */ jsx("label", { className: "text-sm font-medium block mb-1", children: "Role Instructions" }),
      /* @__PURE__ */ jsx("p", { className: "text-xs text-muted-foreground mb-2", children: "System-level context appended to every worker run. Describes who this role is and how it should behave." }),
      /* @__PURE__ */ jsx(
        "textarea",
        {
          value: rolePromptValue,
          onChange: (e) => setRolePromptValue(e.target.value),
          onBlur: saveRolePrompt,
          placeholder: "Describe what this role does...",
          rows: 6,
          className: "w-full text-xs bg-background border border-input rounded-md px-3 py-2 focus:outline-none focus:ring-2 focus:ring-ring resize-y font-mono"
        }
      ),
      /* @__PURE__ */ jsxs("div", { className: "flex items-center gap-2 mt-1.5", children: [
        /* @__PURE__ */ jsxs("span", { className: "text-xs text-muted-foreground", children: [
          "Use ",
          /* @__PURE__ */ jsx("code", { className: "font-mono bg-muted px-1 rounded", children: "{{PLACEHOLDERS}}" }),
          " for dynamic values."
        ] }),
        /* @__PURE__ */ jsx(
          "button",
          {
            type: "button",
            onClick: () => setShowPlaceholders(true),
            className: "text-xs text-primary underline underline-offset-2 hover:text-primary/80",
            children: "View all \u2192"
          }
        )
      ] })
    ] }),
    /* @__PURE__ */ jsxs("div", { className: "mb-6", children: [
      /* @__PURE__ */ jsx("label", { className: "text-sm font-medium block mb-1", children: "Prompt" }),
      /* @__PURE__ */ jsx("p", { className: "text-xs text-muted-foreground mb-2", children: "The task passed to the worker each time it runs." }),
      /* @__PURE__ */ jsx(
        "textarea",
        {
          value: promptValue,
          onChange: (e) => setPromptValue(e.target.value),
          onBlur: savePrompt,
          placeholder: "Execute your role.",
          rows: 5,
          className: "w-full text-xs bg-background border border-input rounded-md px-3 py-2 focus:outline-none focus:ring-2 focus:ring-ring resize-y font-mono"
        }
      ),
      /* @__PURE__ */ jsxs("div", { className: "flex items-center gap-2 mt-1.5", children: [
        /* @__PURE__ */ jsxs("span", { className: "text-xs text-muted-foreground", children: [
          "Use ",
          /* @__PURE__ */ jsx("code", { className: "font-mono bg-muted px-1 rounded", children: "{{PLACEHOLDERS}}" }),
          " for dynamic values."
        ] }),
        /* @__PURE__ */ jsx(
          "button",
          {
            type: "button",
            onClick: () => setShowPlaceholders(true),
            className: "text-xs text-primary underline underline-offset-2 hover:text-primary/80",
            children: "View all \u2192"
          }
        )
      ] })
    ] }),
    /* @__PURE__ */ jsx("div", { className: "border-b border-border mb-6" }),
    /* @__PURE__ */ jsxs("div", { className: "mb-6", children: [
      /* @__PURE__ */ jsx("label", { className: "text-sm font-medium block mb-1", children: "Max Concurrency" }),
      /* @__PURE__ */ jsx(
        "input",
        {
          type: "number",
          min: "1",
          value: maxConcurrency,
          onChange: (e) => setMaxConcurrency(e.target.value),
          onBlur: saveMaxConcurrency,
          onKeyDown: (e) => {
            if (e.key === "Enter") e.target.blur();
          },
          className: "w-20 text-sm bg-background border border-input rounded-md px-3 py-2 focus:outline-none focus:ring-2 focus:ring-ring"
        }
      )
    ] }),
    /* @__PURE__ */ jsxs("div", { className: "mb-6", children: [
      /* @__PURE__ */ jsx("label", { className: "text-sm font-medium block mb-1", children: "Cleanup Worker Dirs" }),
      /* @__PURE__ */ jsxs(
        "button",
        {
          type: "button",
          onClick: toggleCleanup,
          className: "inline-flex items-center gap-2 group",
          role: "switch",
          "aria-checked": cleanupWorkerDir,
          "aria-label": "Cleanup worker directories after run",
          children: [
            /* @__PURE__ */ jsx(
              "span",
              {
                className: `relative inline-flex h-5 w-9 shrink-0 rounded-full transition-colors duration-200 ${cleanupWorkerDir ? "bg-primary" : "bg-muted-foreground/30"}`,
                children: /* @__PURE__ */ jsx(
                  "span",
                  {
                    className: `absolute top-0.5 left-0.5 h-4 w-4 rounded-full bg-white shadow-sm transition-transform duration-200 ${cleanupWorkerDir ? "translate-x-4" : ""}`
                  }
                )
              }
            ),
            /* @__PURE__ */ jsx("span", { className: "text-xs text-muted-foreground", children: cleanupWorkerDir ? "On" : "Off" })
          ]
        }
      )
    ] }),
    /* @__PURE__ */ jsx("div", { className: "border-b border-border mb-6" }),
    /* @__PURE__ */ jsxs("div", { className: "mb-6", children: [
      /* @__PURE__ */ jsx("label", { className: "text-sm font-medium block mb-2", children: "Folders" }),
      /* @__PURE__ */ jsx(
        "input",
        {
          type: "text",
          value: foldersValue,
          onChange: (e) => setFoldersValue(e.target.value),
          onBlur: saveFolders,
          onKeyDown: (e) => {
            if (e.key === "Enter") e.target.blur();
          },
          placeholder: "inbox, output",
          className: "text-sm bg-background border border-input rounded-md px-3 py-2 w-full focus:outline-none focus:ring-2 focus:ring-ring font-mono"
        }
      ),
      /* @__PURE__ */ jsxs("p", { className: "text-xs text-muted-foreground mt-1.5", children: [
        "Comma-separated folder names created under role-",
        shortId,
        "/."
      ] })
    ] }),
    /* @__PURE__ */ jsx("div", { className: "border-b border-border mb-6" }),
    /* @__PURE__ */ jsxs("div", { className: "mb-6", children: [
      /* @__PURE__ */ jsx("label", { className: "text-sm font-medium block mb-2", children: "Triggers" }),
      /* @__PURE__ */ jsxs("div", { className: "flex items-center gap-2 flex-wrap", children: [
        /* @__PURE__ */ jsx("span", { className: "inline-flex items-center rounded-full px-2.5 py-1 text-xs font-medium bg-foreground/10 text-foreground", children: "Manual" }),
        /* @__PURE__ */ jsx("span", { className: "inline-flex items-center rounded-full px-2.5 py-1 text-xs font-medium bg-foreground/10 text-foreground", children: "Webhook" }),
        /* @__PURE__ */ jsx(
          "button",
          {
            onClick: () => toggleTrigger("cron"),
            className: `inline-flex items-center rounded-full px-2.5 py-1 text-xs font-medium border transition-colors ${hasCron ? "bg-foreground text-background border-foreground" : "bg-background text-muted-foreground border-input hover:border-foreground/50"}`,
            children: "Cron"
          }
        ),
        /* @__PURE__ */ jsx(
          "button",
          {
            onClick: () => toggleTrigger("file_watch"),
            className: `inline-flex items-center rounded-full px-2.5 py-1 text-xs font-medium border transition-colors ${hasFileWatch ? "bg-foreground text-background border-foreground" : "bg-background text-muted-foreground border-input hover:border-foreground/50"}`,
            children: "File Watch"
          }
        )
      ] })
    ] }),
    /* @__PURE__ */ jsxs("div", { className: "flex flex-col gap-3 mb-6", children: [
      /* @__PURE__ */ jsx(WebhookInfo, { clusterId, roleId: role.id }),
      hasCron && /* @__PURE__ */ jsxs("div", { children: [
        /* @__PURE__ */ jsx("label", { className: "text-xs font-medium text-muted-foreground block mb-1.5", children: "Cron Schedule" }),
        /* @__PURE__ */ jsx(
          "input",
          {
            type: "text",
            value: cronValue,
            onChange: (e) => setCronValue(e.target.value),
            onBlur: saveCron,
            onKeyDown: (e) => {
              if (e.key === "Enter") e.target.blur();
            },
            placeholder: "*/5 * * * *",
            className: "text-sm bg-background border border-input rounded-md px-3 py-2 w-full focus:outline-none focus:ring-2 focus:ring-ring font-mono"
          }
        )
      ] }),
      hasFileWatch && /* @__PURE__ */ jsxs("div", { children: [
        /* @__PURE__ */ jsx("label", { className: "text-xs font-medium text-muted-foreground block mb-1.5", children: "Watch Paths" }),
        /* @__PURE__ */ jsx(
          "input",
          {
            type: "text",
            value: fileWatchValue,
            onChange: (e) => setFileWatchValue(e.target.value),
            onBlur: saveFileWatch,
            onKeyDown: (e) => {
              if (e.key === "Enter") e.target.blur();
            },
            placeholder: "shared/inbox, shared/reports",
            className: "text-sm bg-background border border-input rounded-md px-3 py-2 w-full focus:outline-none focus:ring-2 focus:ring-ring font-mono"
          }
        ),
        /* @__PURE__ */ jsx("p", { className: "text-xs text-muted-foreground mt-1.5", children: "Comma-separated paths relative to cluster data dir." })
      ] })
    ] }),
    /* @__PURE__ */ jsx("div", { className: "pt-6 border-t border-border", children: /* @__PURE__ */ jsxs(
      "button",
      {
        onClick: () => setConfirmDelete(true),
        className: "inline-flex items-center gap-2 rounded-md px-3 py-2 text-sm font-medium text-destructive border border-destructive/30 hover:bg-destructive/10",
        children: [
          /* @__PURE__ */ jsx(TrashIcon, { size: 16 }),
          "Delete role"
        ]
      }
    ) }),
    /* @__PURE__ */ jsx(
      ConfirmDialog,
      {
        open: confirmDelete,
        title: "Remove role?",
        description: `This will remove "${role.roleName || "Role"}" from the cluster and stop any running containers.`,
        confirmLabel: "Remove",
        onConfirm: () => {
          setConfirmDelete(false);
          onDelete(role.id);
        },
        onCancel: () => setConfirmDelete(false)
      }
    ),
    /* @__PURE__ */ jsx(PlaceholderDialog, { open: showPlaceholders, onClose: () => setShowPlaceholders(false) })
  ] });
}
function CopyButton({ text, label }) {
  const [copied, setCopied] = useState(false);
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(text);
    } catch {
      const ta = document.createElement("textarea");
      ta.value = text;
      document.body.appendChild(ta);
      ta.select();
      document.execCommand("copy");
      document.body.removeChild(ta);
    }
    setCopied(true);
    setTimeout(() => setCopied(false), 2e3);
  };
  return /* @__PURE__ */ jsx(
    "button",
    {
      onClick: copy,
      className: "inline-flex items-center justify-center rounded p-1.5 text-muted-foreground hover:text-foreground hover:bg-muted transition-colors shrink-0",
      title: copied ? "Copied!" : `Copy ${label}`,
      children: copied ? /* @__PURE__ */ jsx(CheckIcon, { size: 14 }) : /* @__PURE__ */ jsx(CopyIcon, { size: 14 })
    }
  );
}
const PLACEHOLDER_ROWS = [
  { name: "{{CLUSTER_HOME}}", example: "/home/claude-code/workspace", desc: "Root of the cluster workspace" },
  { name: "{{CLUSTER_SHARED_DIR}}", example: "/home/claude-code/workspace/shared/", desc: "Cluster shared directory" },
  { name: "{{CLUSTER_SHARED_FOLDERS}}", example: '[".../shared/inbox/",".../shared/outbox/"]', desc: "Cluster shared folders as absolute paths (JSON)" },
  { name: "{{SELF_ROLE_NAME}}", example: "Tech Lead", desc: "Current role's name" },
  { name: "{{SELF_WORKER_ID}}", example: "a1b2c3d4", desc: "This worker's unique ID" },
  { name: "{{SELF_WORK_DIR}}", example: "/home/claude-code/workspace/role-db4d21c0/worker-a1b2c3d4/", desc: "Worker's private dir (where claude starts)" },
  { name: "{{SELF_TMP_DIR}}", example: "/home/claude-code/workspace/role-db4d21c0/worker-a1b2c3d4/tmp/", desc: "Scratch space" },
  { name: "{{DATETIME}}", example: "2026-03-07T20:00:01Z", desc: "Current UTC timestamp" },
  { name: "{{WORKSPACE}}", example: "(full JSON manifest)", desc: "Entire workspace manifest as JSON" },
  { name: "{{WEBHOOK_PAYLOAD}}", example: '{"issue_number": 42, ...}', desc: "Webhook payload as formatted JSON (empty string if no payload)" }
];
const WORKSPACE_EXAMPLE = `{
  "CLUSTER": {
    "CLUSTER_HOME": "/home/claude-code/workspace",
    "CLUSTER_SHARED_DIR": "/home/claude-code/workspace/shared/",
    "CLUSTER_SHARED_FOLDERS": ["/home/claude-code/workspace/shared/inbox/", "/home/claude-code/workspace/shared/outbox/", "/home/claude-code/workspace/shared/testing/"]
  },
  "SELF": {
    "SELF_ROLE_NAME": "Tech Lead",
    "SELF_WORKER_ID": "a1b2c3d4",
    "SELF_WORK_DIR": "/home/claude-code/workspace/role-db4d21c0/worker-a1b2c3d4/",
    "SELF_TMP_DIR": "/home/claude-code/workspace/role-db4d21c0/worker-a1b2c3d4/tmp/"
  }
}`;
function PlaceholderDialog({ open, onClose }) {
  useEffect(() => {
    if (!open) return;
    const handleEsc = (e) => {
      if (e.key === "Escape") onClose();
    };
    document.addEventListener("keydown", handleEsc);
    return () => document.removeEventListener("keydown", handleEsc);
  }, [open, onClose]);
  if (!open) return null;
  return /* @__PURE__ */ jsxs("div", { className: "fixed inset-0 z-50 flex items-center justify-center", children: [
    /* @__PURE__ */ jsx("div", { className: "fixed inset-0 bg-black/50", onClick: onClose }),
    /* @__PURE__ */ jsxs(
      "div",
      {
        className: "relative z-50 w-full max-w-2xl mx-4 rounded-lg border border-border bg-background shadow-lg flex flex-col",
        style: { maxHeight: "85vh" },
        onClick: (e) => e.stopPropagation(),
        children: [
          /* @__PURE__ */ jsxs("div", { className: "flex items-center justify-between px-6 py-4 border-b border-border shrink-0", children: [
            /* @__PURE__ */ jsx("h3", { className: "text-lg font-semibold", children: "Template Placeholders" }),
            /* @__PURE__ */ jsx(
              "button",
              {
                onClick: onClose,
                className: "text-muted-foreground hover:text-foreground p-1 rounded-md hover:bg-muted",
                children: /* @__PURE__ */ jsx("svg", { width: "16", height: "16", viewBox: "0 0 16 16", fill: "none", stroke: "currentColor", strokeWidth: "2", strokeLinecap: "round", children: /* @__PURE__ */ jsx("path", { d: "M4 4l8 8M12 4l-8 8" }) })
              }
            )
          ] }),
          /* @__PURE__ */ jsxs("div", { className: "overflow-y-auto px-6 py-4", children: [
            /* @__PURE__ */ jsx("p", { className: "text-xs text-muted-foreground mb-3", children: "Use these in system prompt, role instructions, and prompt fields. Case-insensitive. Resolved at container launch." }),
            /* @__PURE__ */ jsxs("table", { className: "w-full text-sm mb-6", children: [
              /* @__PURE__ */ jsx("thead", { children: /* @__PURE__ */ jsxs("tr", { className: "border-b border-border text-left", children: [
                /* @__PURE__ */ jsx("th", { className: "py-2 pr-3 font-medium", children: "Variable" }),
                /* @__PURE__ */ jsx("th", { className: "py-2 pr-3 font-medium", children: "Example" }),
                /* @__PURE__ */ jsx("th", { className: "py-2 font-medium", children: "Description" })
              ] }) }),
              /* @__PURE__ */ jsx("tbody", { children: PLACEHOLDER_ROWS.map((row) => /* @__PURE__ */ jsxs("tr", { className: "border-b border-border/50", children: [
                /* @__PURE__ */ jsx("td", { className: "py-2 pr-3 font-mono text-xs whitespace-nowrap", children: row.name }),
                /* @__PURE__ */ jsx("td", { className: "py-2 pr-3 text-xs text-muted-foreground break-all", children: row.example }),
                /* @__PURE__ */ jsx("td", { className: "py-2 text-xs text-muted-foreground", children: row.desc })
              ] }, row.name)) })
            ] }),
            /* @__PURE__ */ jsxs("h4", { className: "text-sm font-medium mb-2", children: [
              "{{WORKSPACE}}",
              " Example"
            ] }),
            /* @__PURE__ */ jsx("pre", { className: "text-xs bg-muted rounded-md px-3 py-2 font-mono overflow-x-auto whitespace-pre", children: WORKSPACE_EXAMPLE })
          ] })
        ]
      }
    )
  ] });
}
function WebhookInfo({ clusterId, roleId }) {
  const origin = typeof window !== "undefined" ? window.location.origin : "https://your-domain.com";
  const endpoint = `${origin}/api/cluster/${clusterId}/role/${roleId}/webhook`;
  const curlCmd = `curl -X POST ${endpoint} \\
  -H "x-api-key: YOUR_API_KEY" \\
  -H "Content-Type: application/json" \\
  -d '{"message": "Hello from webhook"}'`;
  return /* @__PURE__ */ jsxs("div", { className: "rounded-md border border-input p-2.5", children: [
    /* @__PURE__ */ jsx("label", { className: "text-xs font-medium text-muted-foreground block mb-2", children: "Webhook Endpoint" }),
    /* @__PURE__ */ jsxs("div", { className: "flex items-center gap-2 mb-2", children: [
      /* @__PURE__ */ jsx("code", { className: "flex-1 min-w-0 text-xs bg-muted px-2 py-1.5 rounded font-mono text-foreground truncate select-all", children: endpoint }),
      /* @__PURE__ */ jsx(CopyButton, { text: endpoint, label: "endpoint" })
    ] }),
    /* @__PURE__ */ jsx("label", { className: "text-xs font-medium text-muted-foreground block mb-1 mt-2", children: "Example cURL" }),
    /* @__PURE__ */ jsxs("div", { className: "flex items-start gap-2", children: [
      /* @__PURE__ */ jsx("pre", { className: "flex-1 min-w-0 text-xs bg-muted/70 border border-input rounded-md px-2.5 py-2 font-mono text-foreground overflow-x-auto whitespace-pre-wrap break-all leading-relaxed", children: curlCmd }),
      /* @__PURE__ */ jsx(CopyButton, { text: curlCmd, label: "curl command" })
    ] })
  ] });
}
export {
  ClusterPage
};
