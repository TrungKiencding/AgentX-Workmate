import { keepPreviousData, useQuery } from '@tanstack/react-query'
import { useState } from 'react'

import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle
} from '@/components/ui/dialog'
import { proposeSkillToOrg, publishSkillToHub, validateSkillForHub } from '@/hermes'
import { useI18n } from '@/i18n'
import { Loader2 } from '@/lib/icons'
import { cn } from '@/lib/utils'
import type { SkillHubPublishResponse, SkillInfo } from '@/types/hermes'

export type PublishMode = 'upload' | 'propose'

type Visibility = 'private' | 'org' | 'public'

const SELECT_CLASS =
  'h-7 rounded-(--radius-control) border border-(--ui-stroke-tertiary) bg-(--ui-bg-quinary) px-2 text-xs text-foreground outline-none focus-visible:border-ring'

function errorText(result: SkillHubPublishResponse, p: ReturnType<typeof useI18n>['t']['skills']['publish']): string {
  if (result.status === 'signed_out') {
    return p.signedOut
  }

  if (result.status === 'offline') {
    return p.offline
  }

  if (result.status === 'reauth') {
    return p.reauth
  }

  const detail = (result.error_detail ?? {}) as { highest?: string }

  switch (result.code) {
    case 'version_not_newer':
      return p.errors.version_not_newer(detail.highest ?? '?')

    case 'version_exists':
      return p.errors.version_exists

    case 'slug_taken':
      return p.errors.slug_taken

    case 'rate_limited':
      return p.errors.rate_limited

    case 'kind_mismatch':
      return p.errors.kind_mismatch

    default:
      return result.detail || p.failed
  }
}

// "Upload to Hub" / "Propose to organisation" for a local skill: pick the
// visibility (propose pins it to org), preview what the hub would make of
// the files, upload, and show where it went.
export function PublishSkillDialog({
  mode,
  onClose,
  open,
  skill
}: {
  mode: PublishMode
  onClose: () => void
  open: boolean
  skill: SkillInfo
}) {
  const { t } = useI18n()
  const p = t.skills.publish
  const [visibility, setVisibility] = useState<Visibility>(mode === 'propose' ? 'org' : 'private')
  const [kind, setKind] = useState<'' | 'core' | 'browser'>('')
  const [submitting, setSubmitting] = useState(false)
  const [result, setResult] = useState<null | SkillHubPublishResponse>(null)
  const effectiveVisibility: Visibility = mode === 'propose' ? 'org' : visibility

  const preview = useQuery({
    queryKey: ['skill-hub-validate', skill.name, kind, effectiveVisibility],
    queryFn: () => validateSkillForHub(skill.name, { kind: kind || undefined, visibility: effectiveVisibility }),
    enabled: open,
    placeholderData: keepPreviousData,
    staleTime: 30_000
  })

  const pkg = preview.data?.result?.package
  const previewError = preview.data?.result?.error
  const previewOk = preview.data?.ok === true && preview.data.result?.ok === true
  const warnings = [...(pkg?.warnings ?? []), ...(preview.data?.result?.warnings ?? [])]

  const submit = async () => {
    setSubmitting(true)

    try {
      const answer =
        mode === 'propose'
          ? await proposeSkillToOrg(skill.name, { kind: kind || undefined })
          : await publishSkillToHub(skill.name, { visibility: effectiveVisibility, kind: kind || undefined })

      setResult(answer)
    } catch (err) {
      setResult({ ok: false, status: 'error', detail: err instanceof Error ? err.message : String(err) })
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <Dialog onOpenChange={value => !value && onClose()} open={open}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle>{mode === 'propose' ? p.proposeTitle(skill.name) : p.title(skill.name)}</DialogTitle>
          <DialogDescription>{mode === 'propose' ? p.proposeDescription : p.description}</DialogDescription>
        </DialogHeader>

        {result?.ok ? (
          <div className="space-y-2 text-xs" data-testid="publish-done">
            <p className="font-medium text-emerald-400">
              {result.created === false && result.version
                ? p.unchanged(result.version)
                : p.done(result.slug ?? skill.name, result.version ?? '')}
            </p>
            {result.publish_state && (
              <p className="text-muted-foreground">
                {p.doneState[result.publish_state as keyof typeof p.doneState] ?? result.publish_state}
                {' · '}
                {p.visibilityOptions[(result.visibility as Visibility) ?? effectiveVisibility]}
              </p>
            )}
            {(result.warnings ?? []).length > 0 && (
              <p className="text-amber-400">
                {p.warnings}: {(result.warnings ?? []).join('; ')}
              </p>
            )}
            <div className="flex gap-2">
              {result.url && (
                <a className="underline underline-offset-4" href={result.url} rel="noreferrer" target="_blank">
                  {p.openOnHub}
                </a>
              )}
              {result.scan_url && (
                <a className="underline underline-offset-4" href={result.scan_url} rel="noreferrer" target="_blank">
                  {p.openScan}
                </a>
              )}
            </div>
          </div>
        ) : (
          <div className="space-y-3 text-xs">
            <div className="flex flex-wrap items-center gap-3">
              <label className="flex items-center gap-1.5">
                <span className="text-muted-foreground">{p.visibility}</span>
                <select
                  className={SELECT_CLASS}
                  data-testid="publish-visibility"
                  disabled={mode === 'propose'}
                  onChange={event => setVisibility(event.target.value as Visibility)}
                  value={effectiveVisibility}
                >
                  <option value="private">{p.visibilityOptions.private}</option>
                  <option value="org">{p.visibilityOptions.org}</option>
                  <option value="public">{p.visibilityOptions.public}</option>
                </select>
              </label>
              <label className="flex items-center gap-1.5">
                <span className="text-muted-foreground">{p.kind}</span>
                <select
                  className={SELECT_CLASS}
                  data-testid="publish-kind"
                  onChange={event => setKind(event.target.value as '' | 'core' | 'browser')}
                  value={kind}
                >
                  <option value="">{p.kindAuto}</option>
                  <option value="core">{p.kindCore}</option>
                  <option value="browser">{p.kindBrowser}</option>
                </select>
              </label>
            </div>

            <div
              className="rounded-lg border border-(--ui-stroke-tertiary) bg-(--ui-bg-quinary) p-3"
              data-testid="publish-preview"
            >
              <div className="mb-1 flex items-center gap-2 text-2xs text-muted-foreground">
                <span>{p.preview}</span>
                {preview.isFetching ? (
                  <span className="flex items-center gap-1">
                    <Loader2 className="size-3 animate-spin" /> {p.previewLoading}
                  </span>
                ) : preview.data ? (
                  <span
                    className={cn('font-medium', previewOk ? 'text-emerald-400' : 'text-destructive')}
                    data-testid="publish-preview-status"
                  >
                    {previewOk ? p.previewValid : p.previewInvalid}
                  </span>
                ) : null}
              </div>
              {preview.data && !preview.data.ok && (
                <p className="text-amber-400">{preview.data.detail || preview.data.status}</p>
              )}
              {previewError && <p className="text-destructive">{previewError.message || previewError.code}</p>}
              {pkg && (
                <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-0.5 text-2xs">
                  <dt className="text-muted-foreground">{p.previewName}</dt>
                  <dd data-testid="publish-preview-name">{pkg.name}</dd>
                  <dt className="text-muted-foreground">{p.previewVersion}</dt>
                  <dd>{pkg.version}</dd>
                  <dt className="text-muted-foreground">{p.previewKind}</dt>
                  <dd>{pkg.kind}</dd>
                  <dt className="text-muted-foreground">{p.previewFiles}</dt>
                  <dd className="truncate">{pkg.files.join(', ')}</dd>
                </dl>
              )}
              {warnings.length > 0 && (
                <p className="mt-1 text-amber-400">
                  {p.warnings}: {warnings.join('; ')}
                </p>
              )}
            </div>

            {result && !result.ok && (
              <p className="text-destructive" data-testid="publish-error">
                {errorText(result, p)}
              </p>
            )}
          </div>
        )}

        <DialogFooter>
          <Button onClick={onClose} size="sm" variant="text">
            {p.close}
          </Button>
          {!result?.ok && (
            <Button
              data-testid="publish-submit"
              disabled={submitting || !previewOk}
              onClick={() => void submit()}
              size="sm"
            >
              {submitting && <Loader2 className="size-3 animate-spin" />}
              {submitting ? p.submitting : mode === 'propose' ? p.propose : p.submit}
            </Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
