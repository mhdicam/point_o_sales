/**
 * Floor-plan screen — S7-06, design §5.4/§5.5.
 *
 * The dine-in floor for the active outlet. Two things at once:
 *   - the live floor: tables grouped by area, colored by occupancy status, tap a
 *     table to change its status (only the moves the backend machine allows are
 *     offered — legalTableTransitions, UX only);
 *   - config: create/edit areas, tables, and — when `features.kds` is on — KDS
 *     prep stations.
 *
 * Gated on `features.tables` + TABLE_MANAGE (nav hides otherwise). The station
 * editor additionally needs `features.kds` + STATION_MANAGE. The screen reads the
 * outlet from the scoped session; without an outlet scope it explains rather than
 * silently failing (mirrors ShiftScreen).
 */

import { useEffect, useMemo, useState } from 'react'
import type { ReactNode } from 'react'
import { PERMISSIONS } from '@brewsync/shared'
import { useAuthStore } from '../../stores/auth.store.ts'
import {
  useFloorPlanStore,
  type AreaInput,
  type StationInput,
  type TableInput,
} from '../../stores/floor-plan.store.ts'
import { usePermission } from '../../hooks/usePermission.ts'
import { useFeature } from '../../hooks/useFeature.ts'
import {
  floorSummary,
  groupFloor,
  legalTableTransitions,
  tableStatusView,
  type TableTone,
} from '../../lib/floor-plan-view.ts'
import type { Area, Station, Table, TableStatus } from '../../lib/types.ts'
import { Modal } from '../../ui/Modal.tsx'
import {
  Badge,
  Button,
  Checkbox,
  EmptyState,
  ErrorBanner,
  Field,
  Input,
  Select,
  Spinner,
} from '../../ui/primitives.tsx'

// No `warning` token in the palette (tailwind.config.ts) — RESERVED uses the
// muted surface so it reads as "held, not free" without a third accent color.
const TONE_CLASS: Record<TableTone, string> = {
  empty: 'border-line bg-surface text-ink',
  occupied: 'border-brand/40 bg-brand/10 text-brand',
  reserved: 'border-ink-muted/40 bg-surface-muted text-ink-muted',
  dirty: 'border-danger/40 bg-danger/10 text-danger',
}

type Tab = 'floor' | 'areas' | 'tables' | 'stations'

export function FloorPlanScreen(): ReactNode {
  const outletId = useAuthStore((s) => s.scope?.outletId ?? null)
  const { areas, tables, stations, loading, loaded, error, load, clear } = useFloorPlanStore()

  const canManage = usePermission(PERMISSIONS.TABLE_MANAGE)
  const kdsOn = useFeature('kds')
  const canStation = usePermission(PERMISSIONS.STATION_MANAGE)
  const showStations = kdsOn && canStation

  const [tab, setTab] = useState<Tab>('floor')

  useEffect(() => {
    if (outletId) void load(outletId)
    return () => clear()
  }, [outletId, load, clear])

  if (!outletId) {
    return (
      <div className="p-2">
        <ErrorBanner message="This screen needs an outlet-scoped session. Re-select your scope with an outlet." />
      </div>
    )
  }

  const tabs: { key: Tab; label: string; show: boolean }[] = [
    { key: 'floor', label: 'Floor', show: true },
    { key: 'areas', label: 'Areas', show: canManage },
    { key: 'tables', label: 'Tables', show: canManage },
    { key: 'stations', label: 'Stations', show: showStations },
  ]

  return (
    <div className="flex flex-col gap-4">
      <header className="flex items-center justify-between">
        <h1 className="text-lg font-semibold text-ink">Floor plan</h1>
      </header>

      <nav className="flex gap-1 overflow-x-auto border-b border-line">
        {tabs
          .filter((t) => t.show)
          .map((t) => (
            <button
              key={t.key}
              onClick={() => setTab(t.key)}
              className={`min-h-tap border-b-2 px-4 text-sm font-medium transition ${
                tab === t.key
                  ? 'border-brand text-brand'
                  : 'border-transparent text-ink-muted hover:text-ink'
              }`}
            >
              {t.label}
            </button>
          ))}
      </nav>

      {error ? <ErrorBanner message={error} /> : null}

      {loading && !loaded ? (
        <Spinner />
      ) : tab === 'floor' ? (
        <FloorView areas={areas} tables={tables} canManage={canManage} />
      ) : tab === 'areas' ? (
        <AreasTab areas={areas} />
      ) : tab === 'tables' ? (
        <TablesTab areas={areas} tables={tables} />
      ) : tab === 'stations' ? (
        <StationsTab stations={stations} />
      ) : null}
    </div>
  )
}

// --- Floor (live) -----------------------------------------------------------

function FloorView({
  areas,
  tables,
  canManage,
}: {
  areas: Area[]
  tables: Table[]
  canManage: boolean
}): ReactNode {
  // Live floor: hide inactive tables; the config tab shows them.
  const groups = useMemo(
    () => groupFloor(areas, tables, { includeInactiveTables: false }),
    [areas, tables]
  )
  const summary = useMemo(() => floorSummary(tables), [tables])
  const [active, setActive] = useState<Table | null>(null)

  if (summary.total === 0) {
    return <EmptyState title="No tables yet" hint="Add tables in the Tables tab to see the floor." />
  }

  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-wrap gap-2 text-xs text-ink-muted">
        <Badge tone="muted">{summary.total} tables</Badge>
        <Badge tone="active">{summary.byStatus.OCCUPIED} occupied</Badge>
        <Badge tone="muted">{summary.byStatus.RESERVED} reserved</Badge>
        <Badge tone="muted">{summary.byStatus.DIRTY} dirty</Badge>
      </div>

      {groups.map((group) => (
        <section key={group.areaId ?? 'none'} className="flex flex-col gap-2">
          <h2 className="text-sm font-semibold text-ink-muted">{group.name}</h2>
          {group.tables.length === 0 ? (
            <p className="text-xs text-ink-muted">No tables in this area.</p>
          ) : (
            <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-6">
              {group.tables.map((t) => {
                const view = tableStatusView(t.status)
                return (
                  <button
                    key={t.id}
                    onClick={() => canManage && setActive(t)}
                    disabled={!canManage}
                    className={`flex min-h-[88px] flex-col items-start justify-between rounded-xl border-2 p-3 text-left transition disabled:cursor-default ${TONE_CLASS[view.tone]}`}
                  >
                    <span className="text-base font-semibold">{t.code}</span>
                    <span className="text-xs opacity-80">{view.label}</span>
                    {t.capacity ? (
                      <span className="text-[11px] opacity-60">seats {t.capacity}</span>
                    ) : null}
                  </button>
                )
              })}
            </div>
          )}
        </section>
      ))}

      {active ? <StatusDialog table={active} onClose={() => setActive(null)} /> : null}
    </div>
  )
}

function StatusDialog({ table, onClose }: { table: Table; onClose: () => void }): ReactNode {
  const setTableStatus = useFloorPlanStore((s) => s.setTableStatus)
  const busy = useFloorPlanStore((s) => s.busy)
  const [err, setErr] = useState<string | null>(null)

  const moves = legalTableTransitions(table.status)

  const apply = async (status: TableStatus): Promise<void> => {
    setErr(null)
    try {
      await setTableStatus(table.id, status)
      onClose()
    } catch (e) {
      setErr(e instanceof Error ? e.message : 'Unable to change status')
    }
  }

  return (
    <Modal
      title={`${table.code} — ${tableStatusView(table.status).label}`}
      onClose={onClose}
      footer={
        <Button variant="ghost" onClick={onClose} disabled={busy}>
          Close
        </Button>
      }
    >
      <div className="flex flex-col gap-3">
        {err ? <p className="text-sm text-danger">{err}</p> : null}
        {moves.length === 0 ? (
          <p className="text-sm text-ink-muted">
            This table&apos;s status changes with its order — no manual move available.
          </p>
        ) : (
          <>
            <p className="text-sm text-ink-muted">Change status to:</p>
            <div className="flex flex-wrap gap-2">
              {moves.map((status) => (
                <Button
                  key={status}
                  variant="secondary"
                  onClick={() => apply(status)}
                  disabled={busy}
                >
                  {tableStatusView(status).label}
                </Button>
              ))}
            </div>
          </>
        )}
      </div>
    </Modal>
  )
}

// --- Areas config -----------------------------------------------------------

function AreasTab({ areas }: { areas: Area[] }): ReactNode {
  const [formOpen, setFormOpen] = useState(false)
  const [editing, setEditing] = useState<Area | null>(null)

  const ordered = useMemo(
    () => areas.slice().sort((a, b) => a.sortOrder - b.sortOrder || a.name.localeCompare(b.name)),
    [areas]
  )

  return (
    <div className="flex flex-col gap-4">
      <div className="flex justify-end">
        <Button
          onClick={() => {
            setEditing(null)
            setFormOpen(true)
          }}
        >
          New area
        </Button>
      </div>
      <div className="rounded-xl border border-line bg-surface">
        {ordered.length === 0 ? (
          <EmptyState title="No areas" hint="Group tables into areas (Indoor, Terrace, …)." />
        ) : (
          <ul>
            {ordered.map((a) => (
              <li
                key={a.id}
                className="flex items-center gap-3 border-b border-line px-4 py-3 last:border-b-0"
              >
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2">
                    <span className="truncate text-sm font-medium text-ink">{a.name}</span>
                    <Badge tone="muted">{a.kind}</Badge>
                    {!a.isActive ? <Badge tone="muted">Inactive</Badge> : null}
                  </div>
                </div>
                <Button
                  variant="secondary"
                  onClick={() => {
                    setEditing(a)
                    setFormOpen(true)
                  }}
                  className="h-9 px-3 text-xs"
                >
                  Edit
                </Button>
              </li>
            ))}
          </ul>
        )}
      </div>
      {formOpen ? <AreaForm area={editing} onClose={() => setFormOpen(false)} /> : null}
    </div>
  )
}

function AreaForm({ area, onClose }: { area: Area | null; onClose: () => void }): ReactNode {
  const { createArea, updateArea, removeArea } = useFloorPlanStore()
  const isEdit = area !== null
  const [name, setName] = useState(area?.name ?? '')
  const [kind, setKind] = useState<Area['kind']>(area?.kind ?? 'AREA')
  const [isActive, setIsActive] = useState(area?.isActive ?? true)
  const [err, setErr] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  const submit = async (): Promise<void> => {
    setErr(null)
    setBusy(true)
    try {
      if (area) {
        await updateArea(area.id, { name: name.trim(), isActive })
      } else {
        const input: AreaInput = { name: name.trim(), kind }
        await createArea(input)
      }
      onClose()
    } catch (e) {
      setErr(e instanceof Error ? e.message : 'Unable to save area')
      setBusy(false)
    }
  }

  const del = async (): Promise<void> => {
    if (!area) return
    setErr(null)
    setBusy(true)
    try {
      await removeArea(area.id)
      onClose()
    } catch (e) {
      setErr(e instanceof Error ? e.message : 'Unable to delete area')
      setBusy(false)
    }
  }

  return (
    <Modal
      title={isEdit ? 'Edit area' : 'New area'}
      onClose={onClose}
      footer={
        <>
          {isEdit ? (
            <Button variant="danger" onClick={del} disabled={busy} className="mr-auto">
              Deactivate
            </Button>
          ) : null}
          <Button variant="ghost" onClick={onClose} disabled={busy}>
            Cancel
          </Button>
          <Button onClick={submit} disabled={busy}>
            {busy ? 'Saving…' : isEdit ? 'Save' : 'Create'}
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-4">
        {err ? <p className="text-sm text-danger">{err}</p> : null}
        <Field label="Name">
          <Input value={name} onChange={(e) => setName(e.target.value)} />
        </Field>
        {!isEdit ? (
          <Field label="Kind">
            <Select value={kind} onChange={(e) => setKind(e.target.value as Area['kind'])}>
              <option value="AREA">Area (section)</option>
              <option value="FLOOR">Floor (top level)</option>
            </Select>
          </Field>
        ) : null}
        {isEdit ? (
          <Checkbox
            label="Active"
            checked={isActive}
            onChange={(e) => setIsActive(e.target.checked)}
          />
        ) : null}
      </div>
    </Modal>
  )
}

// --- Tables config ----------------------------------------------------------

function TablesTab({ areas, tables }: { areas: Area[]; tables: Table[] }): ReactNode {
  const [formOpen, setFormOpen] = useState(false)
  const [editing, setEditing] = useState<Table | null>(null)

  const groups = useMemo(() => groupFloor(areas, tables, { includeInactiveTables: true }), [
    areas,
    tables,
  ])

  return (
    <div className="flex flex-col gap-4">
      <div className="flex justify-end">
        <Button
          onClick={() => {
            setEditing(null)
            setFormOpen(true)
          }}
        >
          New table
        </Button>
      </div>
      {groups.length === 0 ? (
        <div className="rounded-xl border border-line bg-surface">
          <EmptyState title="No tables" hint="Add the outlet's tables to build the floor." />
        </div>
      ) : (
        groups.map((group) => (
          <section key={group.areaId ?? 'none'} className="flex flex-col gap-2">
            <h2 className="text-sm font-semibold text-ink-muted">{group.name}</h2>
            <div className="rounded-xl border border-line bg-surface">
              <ul>
                {group.tables.map((t) => (
                  <li
                    key={t.id}
                    className="flex items-center gap-3 border-b border-line px-4 py-3 last:border-b-0"
                  >
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center gap-2">
                        <span className="truncate text-sm font-medium text-ink">{t.code}</span>
                        <span className="truncate text-xs text-ink-muted">{t.name}</span>
                        {!t.isActive ? <Badge tone="muted">Inactive</Badge> : null}
                      </div>
                    </div>
                    <Button
                      variant="secondary"
                      onClick={() => {
                        setEditing(t)
                        setFormOpen(true)
                      }}
                      className="h-9 px-3 text-xs"
                    >
                      Edit
                    </Button>
                  </li>
                ))}
              </ul>
            </div>
          </section>
        ))
      )}
      {formOpen ? (
        <TableForm table={editing} areas={areas} onClose={() => setFormOpen(false)} />
      ) : null}
    </div>
  )
}

function TableForm({
  table,
  areas,
  onClose,
}: {
  table: Table | null
  areas: Area[]
  onClose: () => void
}): ReactNode {
  const { createTable, updateTable, removeTable } = useFloorPlanStore()
  const isEdit = table !== null
  const [code, setCode] = useState(table?.code ?? '')
  const [name, setName] = useState(table?.name ?? '')
  const [areaId, setAreaId] = useState<string | null>(table?.areaId ?? null)
  const [capacity, setCapacity] = useState(table?.capacity != null ? String(table.capacity) : '')
  const [isActive, setIsActive] = useState(table?.isActive ?? true)
  const [err, setErr] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  const activeAreas = useMemo(() => areas.filter((a) => a.isActive), [areas])

  const submit = async (): Promise<void> => {
    setErr(null)
    setBusy(true)
    const cap = capacity.trim() === '' ? null : Number(capacity)
    try {
      if (table) {
        await updateTable(table.id, {
          name: name.trim(),
          areaId,
          capacity: cap,
          isActive,
        })
      } else {
        const input: TableInput = { code: code.trim(), name: name.trim(), areaId, capacity: cap }
        await createTable(input)
      }
      onClose()
    } catch (e) {
      setErr(e instanceof Error ? e.message : 'Unable to save table')
      setBusy(false)
    }
  }

  const del = async (): Promise<void> => {
    if (!table) return
    setErr(null)
    setBusy(true)
    try {
      await removeTable(table.id)
      onClose()
    } catch (e) {
      setErr(e instanceof Error ? e.message : 'Unable to delete table')
      setBusy(false)
    }
  }

  return (
    <Modal
      title={isEdit ? 'Edit table' : 'New table'}
      onClose={onClose}
      footer={
        <>
          {isEdit ? (
            <Button variant="danger" onClick={del} disabled={busy} className="mr-auto">
              Deactivate
            </Button>
          ) : null}
          <Button variant="ghost" onClick={onClose} disabled={busy}>
            Cancel
          </Button>
          <Button onClick={submit} disabled={busy}>
            {busy ? 'Saving…' : isEdit ? 'Save' : 'Create'}
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-4">
        {err ? <p className="text-sm text-danger">{err}</p> : null}
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Code">
            <Input
              value={code}
              disabled={isEdit}
              onChange={(e) => setCode(e.target.value)}
              placeholder="T1"
            />
          </Field>
          <Field label="Name">
            <Input value={name} onChange={(e) => setName(e.target.value)} placeholder="Table 1" />
          </Field>
        </div>
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Area">
            <Select value={areaId ?? ''} onChange={(e) => setAreaId(e.target.value || null)}>
              <option value="">No area</option>
              {activeAreas.map((a) => (
                <option key={a.id} value={a.id}>
                  {a.name}
                </option>
              ))}
            </Select>
          </Field>
          <Field label="Capacity">
            <Input
              type="number"
              min={1}
              value={capacity}
              onChange={(e) => setCapacity(e.target.value)}
              placeholder="4"
            />
          </Field>
        </div>
        {isEdit ? (
          <Checkbox
            label="Active"
            checked={isActive}
            onChange={(e) => setIsActive(e.target.checked)}
          />
        ) : null}
      </div>
    </Modal>
  )
}

// --- Stations config --------------------------------------------------------

function StationsTab({ stations }: { stations: Station[] }): ReactNode {
  const [formOpen, setFormOpen] = useState(false)
  const [editing, setEditing] = useState<Station | null>(null)

  const ordered = useMemo(
    () =>
      stations.slice().sort((a, b) => a.sortOrder - b.sortOrder || a.name.localeCompare(b.name)),
    [stations]
  )

  return (
    <div className="flex flex-col gap-4">
      <div className="flex justify-end">
        <Button
          onClick={() => {
            setEditing(null)
            setFormOpen(true)
          }}
        >
          New station
        </Button>
      </div>
      <div className="rounded-xl border border-line bg-surface">
        {ordered.length === 0 ? (
          <EmptyState
            title="No stations"
            hint="Prep stations (Bar, Kitchen) route made-to-order lines to the right screen."
          />
        ) : (
          <ul>
            {ordered.map((s) => (
              <li
                key={s.id}
                className="flex items-center gap-3 border-b border-line px-4 py-3 last:border-b-0"
              >
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2">
                    <span className="truncate text-sm font-medium text-ink">{s.name}</span>
                    {!s.isActive ? <Badge tone="muted">Inactive</Badge> : null}
                  </div>
                </div>
                <Button
                  variant="secondary"
                  onClick={() => {
                    setEditing(s)
                    setFormOpen(true)
                  }}
                  className="h-9 px-3 text-xs"
                >
                  Edit
                </Button>
              </li>
            ))}
          </ul>
        )}
      </div>
      {formOpen ? <StationForm station={editing} onClose={() => setFormOpen(false)} /> : null}
    </div>
  )
}

function StationForm({
  station,
  onClose,
}: {
  station: Station | null
  onClose: () => void
}): ReactNode {
  const { createStation, updateStation, removeStation } = useFloorPlanStore()
  const isEdit = station !== null
  const [name, setName] = useState(station?.name ?? '')
  const [isActive, setIsActive] = useState(station?.isActive ?? true)
  const [err, setErr] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  const submit = async (): Promise<void> => {
    setErr(null)
    setBusy(true)
    try {
      if (station) {
        await updateStation(station.id, { name: name.trim(), isActive })
      } else {
        const input: StationInput = { name: name.trim() }
        await createStation(input)
      }
      onClose()
    } catch (e) {
      setErr(e instanceof Error ? e.message : 'Unable to save station')
      setBusy(false)
    }
  }

  const del = async (): Promise<void> => {
    if (!station) return
    setErr(null)
    setBusy(true)
    try {
      await removeStation(station.id)
      onClose()
    } catch (e) {
      setErr(e instanceof Error ? e.message : 'Unable to delete station')
      setBusy(false)
    }
  }

  return (
    <Modal
      title={isEdit ? 'Edit station' : 'New station'}
      onClose={onClose}
      footer={
        <>
          {isEdit ? (
            <Button variant="danger" onClick={del} disabled={busy} className="mr-auto">
              Deactivate
            </Button>
          ) : null}
          <Button variant="ghost" onClick={onClose} disabled={busy}>
            Cancel
          </Button>
          <Button onClick={submit} disabled={busy}>
            {busy ? 'Saving…' : isEdit ? 'Save' : 'Create'}
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-4">
        {err ? <p className="text-sm text-danger">{err}</p> : null}
        <Field label="Name">
          <Input value={name} onChange={(e) => setName(e.target.value)} placeholder="Bar" />
        </Field>
        {isEdit ? (
          <Checkbox
            label="Active"
            checked={isActive}
            onChange={(e) => setIsActive(e.target.checked)}
          />
        ) : null}
      </div>
    </Modal>
  )
}
