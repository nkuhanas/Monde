import type { FormEvent } from "react";
import type { CronScheduleDto, MonDto } from "@monde/core";
import { Badge, EmptyState } from "../../components/ui";
import { monDisplayName, monIdDisplayName } from "../../lib/mon";

export function CronView({
  schedules,
  mons,
  canCreate,
  name,
  setName,
  expression,
  setExpression,
  timezone,
  setTimezone,
  monId,
  setMonId,
  prompt,
  setPrompt,
  onCreate,
  onToggle,
  onArchive
}: {
  schedules: CronScheduleDto[];
  mons: MonDto[];
  canCreate: boolean;
  name: string;
  setName(value: string): void;
  expression: string;
  setExpression(value: string): void;
  timezone: string;
  setTimezone(value: string): void;
  monId: string;
  setMonId(value: string): void;
  prompt: string;
  setPrompt(value: string): void;
  onCreate(event: FormEvent): void;
  onToggle(schedule: CronScheduleDto): void;
  onArchive(schedule: CronScheduleDto): void;
}) {
  return (
    <section className="tab-panel">
      <div className="section-head">
        <div>
          <p className="eyebrow">Cron</p>
          <h3>Scheduled Monde activations</h3>
        </div>
        <span className="subtle-count">{schedules.length} schedule(s)</span>
      </div>
      <form className="cron-create" onSubmit={onCreate}>
        <input
          value={name}
          onChange={(event) => setName(event.target.value)}
          placeholder="Schedule name"
        />
        <input
          value={expression}
          onChange={(event) => setExpression(event.target.value)}
          placeholder="0 9 * * 1-5"
          aria-label="Five-field cron expression"
        />
        <input
          value={timezone}
          onChange={(event) => setTimezone(event.target.value)}
          placeholder="UTC"
          aria-label="IANA timezone"
        />
        <select
          value={monId}
          onChange={(event) => setMonId(event.target.value)}
        >
          {mons.map((mon) => (
            <option value={mon.id} key={mon.id}>
              {monDisplayName(mon)}
            </option>
          ))}
        </select>
        <input
          value={prompt}
          onChange={(event) => setPrompt(event.target.value)}
          placeholder="Prompt to enqueue"
        />
        <button
          className="primary-action"
          type="submit"
          disabled={
            !canCreate ||
            !name ||
            !expression ||
            !timezone ||
            !monId ||
            !prompt
          }
        >
          Create schedule
        </button>
      </form>
      <div className="cron-grid">
        {schedules.map((schedule) => (
          <article className="cron-card" key={schedule.id}>
            <div>
              <div className="card-kicker">{schedule.id}</div>
              <h4>{schedule.name}</h4>
              <p>{schedule.title}</p>
            </div>
            <div className="cron-card-meta">
              <Badge tone={schedule.enabled ? "green" : "default"}>
                {schedule.enabled ? "enabled" : "paused"}
              </Badge>
              <Badge>{monIdDisplayName(schedule.mon_id)}</Badge>
              <code>{schedule.expression}</code>
              <span>{schedule.timezone}</span>
            </div>
            <dl className="cron-times">
              <div>
                <dt>Next</dt>
                <dd>{formatTime(schedule.next_fire_at)}</dd>
              </div>
              <div>
                <dt>Last</dt>
                <dd>{formatTime(schedule.last_fired_at)}</dd>
              </div>
              {schedule.pending_fire_at ? (
                <div>
                  <dt>Coalesced pending fire</dt>
                  <dd>{formatTime(schedule.pending_fire_at)}</dd>
                </div>
              ) : null}
            </dl>
            <div className="cron-actions">
              <button type="button" onClick={() => onToggle(schedule)}>
                {schedule.enabled ? "Pause" : "Enable"}
              </button>
              <button
                className="danger-menu-item"
                type="button"
                onClick={() => onArchive(schedule)}
              >
                Archive
              </button>
            </div>
          </article>
        ))}
        {schedules.length === 0 ? (
          <EmptyState
            title="No cron schedules"
            body="Create a generic schedule to enqueue a Mon run. Cron does not define retries or workflows."
          />
        ) : null}
      </div>
    </section>
  );
}

function formatTime(value: string | null): string {
  return value ? new Date(value).toLocaleString() : "—";
}
