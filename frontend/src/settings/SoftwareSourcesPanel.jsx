import React, { useCallback, useEffect, useRef, useState } from 'react';
import { useAppStore } from '../stores/useAppStore.js';

const button =
  'rounded-lg border border-white/10 px-3 py-2 text-xs hover:bg-white/5 disabled:opacity-40';
const input =
  'mt-1 w-full rounded-lg border border-white/10 bg-black/20 p-2 text-sm text-stone-200';
export default function SoftwareSourcesPanel() {
  const activeOperation = useAppStore((state) => state.softwareOperation);
  const cancelOperation = useAppStore((state) => state.cancelSoftwareOperation);
  const [providers, setProviders] = useState(null),
    [busy, setBusy] = useState(false),
    [notice, setNotice] = useState(''),
    [failure, setFailure] = useState('');
  const [product, setProduct] = useState(''),
    [operation, setOperation] = useState('install'),
    [version, setVersion] = useState(''),
    [found, setFound] = useState(null),
    [plan, setPlan] = useState(null);
  const queryRevision = useRef(0);
  const changeQuery = (update, value) => {
    queryRevision.current += 1;
    update(value);
    setFound(null);
    setPlan(null);
    setNotice('');
    setFailure('');
  };
  const [kind, setKind] = useState('json-feed'),
    [sourceId, setSourceId] = useState(''),
    [sourceName, setSourceName] = useState(''),
    [origin, setOrigin] = useState(''),
    [metadataUrl, setMetadataUrl] = useState(''),
    [publisher, setPublisher] = useState(''),
    [hosts, setHosts] = useState(''),
    [credential, setCredential] = useState(''),
    [directory, setDirectory] = useState(''),
    [enterprise, setEnterprise] = useState(false);
  const [releaseProductId, setReleaseProductId] = useState(''),
    [releaseProductName, setReleaseProductName] = useState(''),
    [repository, setRepository] = useState('');
  const refresh = useCallback(async () => {
    if (!window.softwareAPI) return;
    const result = await window.softwareAPI.providers();
    if (result.success !== true)
      throw new Error(result.error?.message || 'Software providers are unavailable.');
    setProviders(result.data);
  }, []);
  useEffect(() => {
    refresh().catch((error) => setFailure(error.message));
  }, [refresh]);
  const act = async (job) => {
    setBusy(true);
    setFailure('');
    setNotice('');
    try {
      return await job();
    } catch (error) {
      setFailure(error.message || 'The software action could not be completed.');
    } finally {
      setBusy(false);
    }
  };
  const receive = (result, onData, isCurrent = () => true) => {
    if (!isCurrent()) return;
    if (result.needsConfirmation) {
      useAppStore.getState().addConfirmation({
        confirmationId: result.confirmationId,
        message: result.message,
        approvalDetails: result.approvalDetails,
        standalone: true,
        onSettled: (settled) => {
          if (!isCurrent()) return;
          setNotice('');
          setFailure('');
          if (settled?.success === false || settled?.data?.success === false) {
            setFailure(
              settled.error?.message ||
                settled.data?.message ||
                'The software action failed. No successful installation has been verified.',
            );
          } else if (settled?.success === true && settled.data) {
            setNotice(settled.data.message || 'The software action returned a result.');
            onData?.(settled.data);
          } else if (settled?.success === true) {
            setNotice('The request was declined. No software action was executed.');
          } else {
            setFailure('The software action returned no result. Try the action again.');
          }
          refresh().catch(() => {});
        },
      });
      setNotice('Review this exact action in the approval dialog.');
      return;
    }
    if (result.success !== true || result.data?.success === false)
      throw new Error(
        result.error?.message || result.data?.message || 'The software operation was not verified.',
      );
    if (result.data) {
      onData?.(result.data);
      setNotice(result.data.message || 'Ready for review.');
    }
  };
  const discover = (online) => {
    const revision = ++queryRevision.current;
    setFound(null);
    setPlan(null);
    return act(async () =>
      receive(
        await window.softwareAPI.discover(
          { operation, product, ...(version.trim() ? { version: version.trim() } : {}) },
          online,
        ),
        (data) => {
          setFound(data);
          setPlan(null);
        },
        () => queryRevision.current === revision,
      ),
    );
  };
  const select = (candidate) => {
    const revision = queryRevision.current;
    return act(async () => {
      setPlan(null);
      if (found.requiresChoice) {
        const choice = await window.softwareAPI.choose(found.discoveryId, candidate.candidateId);
        if (choice?.success !== true || choice.data?.success === false)
          throw new Error(
            choice?.error?.message ||
              choice?.data?.message ||
              'The software selection was not accepted. Search for the product again.',
          );
      }
      if (queryRevision.current !== revision) return;
      receive(
        await window.softwareAPI.resolve(candidate.candidateId),
        (data) => setPlan(data.plan),
        () => queryRevision.current === revision,
      );
    });
  };
  const requestPlanAction = (action) => {
    const revision = queryRevision.current;
    return act(async () =>
      receive(
        await window.softwareAPI.requestAction(action, plan.planId),
        action === 'download' ? (data) => data.plan && setPlan(data.plan) : undefined,
        () => queryRevision.current === revision,
      ),
    );
  };
  const enroll = (event) => {
    event.preventDefault();
    act(async () => {
      const publishers = publisher
        .split(',')
        .map((value) => value.trim())
        .filter(Boolean);
      const descriptor = {
        schemaVersion: 1,
        id: sourceId.trim(),
        kind,
        name: sourceName.trim(),
        origin: kind === 'local-repository' ? `Local repository: ${directory}` : origin.trim(),
        publishers,
        ...(kind === 'local-repository'
          ? { directory }
          : {
              allowedHosts: hosts
                .split(',')
                .map((value) => value.trim())
                .filter(Boolean),
              networkClass: enterprise ? 'enterprise' : 'public',
            }),
        ...(['json-feed', 'release-api'].includes(kind) ? { metadataUrl: metadataUrl.trim() } : {}),
        ...(kind === 'release-api'
          ? {
              product: {
                id: releaseProductId.trim(),
                name: releaseProductName.trim(),
                publisher: publishers[0],
              },
            }
          : {}),
        ...(kind === 'package-repository'
          ? { manager: 'winget', ...(repository.trim() ? { repository: repository.trim() } : {}) }
          : {}),
      };
      const result = await window.softwareAPI.registerSource(descriptor, credential || undefined);
      setCredential('');
      receive(result);
    });
  };
  if (!window.softwareAPI)
    return (
      <p className="text-sm text-stone-400">
        Software installation runs in the Windows desktop app. Development browser chat cannot
        launch installers.
      </p>
    );
  return (
    <div className="space-y-5 text-sm text-stone-300">
      <div>
        <h3 className="font-semibold text-white">Software sources</h3>
        <p className="mt-1 text-xs text-stone-500">
          Discover installed providers, approved repositories and verified offline installers. No
          fixed application list.
        </p>
      </div>
      {failure && (
        <p role="alert" className="text-xs text-red-300">
          {failure}
        </p>
      )}
      {notice && (
        <p role="status" className="text-xs text-blue-300">
          {notice}
        </p>
      )}
      {activeOperation && (
        <div role="status" className="rounded-lg border border-blue-500/20 p-3 text-xs">
          <p>{activeOperation.status}</p>
          <button type="button" className={`${button} mt-2`} onClick={cancelOperation}>
            Cancel current software action
          </button>
        </div>
      )}
      <section className="rounded-xl border border-white/10 p-3 space-y-2">
        <div className="flex items-center justify-between gap-2">
          <h4 className="font-medium">Available provider interfaces</h4>
          <button type="button" className={button} disabled={busy} onClick={() => act(refresh)}>
            Refresh providers
          </button>
        </div>
        {providers?.providers?.map((provider) => (
          <p key={provider.id} className="break-words text-xs">
            {provider.name}{' '}
            <span className="text-stone-500">
              · {provider.id} ·{' '}
              {provider.capabilities.network
                ? 'requires approved online lookup'
                : 'offline or user-assisted'}
            </span>
          </p>
        ))}
        {!providers && (
          <p role="status" className="text-xs text-stone-500">
            Inspecting local software providers…
          </p>
        )}
        <p className="text-xs text-stone-500">
          {providers?.cachedInstallers || 0} verified cached installers
        </p>
        {providers?.diagnostics?.map((item, index) => (
          <p key={index} className="text-xs text-amber-300">
            {item.providerId}: {item.message}
          </p>
        ))}
      </section>
      <section className="rounded-xl border border-white/10 p-3 space-y-3">
        <h4 className="font-medium">Find software</h4>
        <label className="block text-xs">
          Product name
          <input
            className={input}
            maxLength={180}
            value={product}
            onChange={(event) => changeQuery(setProduct, event.target.value)}
          />
        </label>
        <div className="grid grid-cols-2 gap-2">
          <label className="block text-xs">
            Action
            <select
              className={input}
              value={operation}
              onChange={(event) => changeQuery(setOperation, event.target.value)}
            >
              {['install', 'download', 'update', 'reinstall'].map((value) => (
                <option key={value}>{value}</option>
              ))}
            </select>
          </label>
          <label className="block text-xs">
            Version (optional)
            <input
              className={input}
              maxLength={80}
              value={version}
              onChange={(event) => changeQuery(setVersion, event.target.value)}
            />
          </label>
        </div>
        <div className="flex flex-wrap gap-2">
          <button
            type="button"
            className={button}
            disabled={busy || !product.trim()}
            onClick={() => discover(false)}
          >
            Search offline sources
          </button>
          <button
            type="button"
            className={button}
            disabled={busy || !product.trim()}
            onClick={() => discover(true)}
          >
            Review online lookup
          </button>
          <button
            type="button"
            className={button}
            disabled={busy || !product.trim()}
            onClick={() =>
              act(async () => {
                const revision = queryRevision.current;
                const result = await window.softwareAPI.pickInstaller(product);
                if (!result.cancelled && queryRevision.current === revision) {
                  setFound(null);
                  setPlan(result.plan);
                  setNotice(result.message);
                }
              })
            }
          >
            Choose signed local installer
          </button>
        </div>
        {found?.requiresOnline && (
          <div className="rounded-lg border border-blue-500/20 p-3 text-xs">
            <p>
              Check online providers for an installable package before using a user-assisted page.
            </p>
            <button
              type="button"
              className={`${button} mt-2`}
              disabled={busy || !product.trim()}
              onClick={() => discover(true)}
            >
              Search online installation sources
            </button>
          </div>
        )}
        {found?.failures?.map((item, index) => (
          <p key={index} className="text-xs text-amber-300">
            {item.providerId}: {item.message}
          </p>
        ))}
        {found?.candidates?.map((candidate) => (
          <button
            type="button"
            key={candidate.candidateId}
            className={`${button} block w-full text-left`}
            disabled={busy}
            onClick={() => select(candidate)}
          >
            {candidate.name} · {candidate.publisher || 'Publisher unresolved'} ·{' '}
            {candidate.version || 'Version unresolved'}
            <span className="mt-1 block break-words text-stone-500">
              {candidate.source}
              {candidate.handoff ? ' · user-assisted interface' : ''}
            </span>
          </button>
        ))}
        {plan && (
          <div className="rounded-lg bg-black/20 p-3 space-y-2 text-xs">
            <p className="font-medium">
              {plan.name} · {plan.publisher || 'Publisher unresolved'} ·{' '}
              {plan.version || 'Version unresolved'}
            </p>
            <p className="break-words">{plan.source}</p>
            <p>
              Privileges: {plan.privileges} · Reboot: {plan.reboot}
            </p>
            <div className="flex flex-wrap gap-2">
              {plan.protocol === 'handoff' ? (
                <>
                  <p className="w-full text-amber-300">
                    This source provides a page for you to complete installation. No installer has
                    run. Search online sources for an installable package or choose a signed local
                    installer.
                  </p>
                  <button
                    type="button"
                    className={button}
                    disabled={busy}
                    onClick={() => act(() => window.softwareAPI.reveal(plan.planId))}
                  >
                    Open official user-assisted page
                  </button>
                  <button
                    type="button"
                    className={button}
                    disabled={busy || !product.trim()}
                    onClick={() => discover(true)}
                  >
                    Search online installation sources
                  </button>
                </>
              ) : (
                <>
                  <button
                    type="button"
                    className={button}
                    disabled={busy}
                    onClick={() => requestPlanAction('download')}
                  >
                    Review download/copy
                  </button>
                  {plan.operation !== 'download' && plan.protocol !== 'download' && (
                    <button
                      type="button"
                      className={button}
                      disabled={busy}
                      onClick={() => requestPlanAction('install')}
                    >
                      Review installation
                    </button>
                  )}
                  <button
                    type="button"
                    className={button}
                    disabled={busy}
                    onClick={() => requestPlanAction('verify')}
                  >
                    Check installed identity
                  </button>
                  <button
                    type="button"
                    className={button}
                    disabled={busy}
                    onClick={() => act(() => window.softwareAPI.reveal(plan.planId))}
                  >
                    Show cached installer
                  </button>
                </>
              )}
            </div>
          </div>
        )}
      </section>
      <details className="rounded-xl border border-white/10 p-3">
        <summary className="cursor-pointer text-sm font-medium">
          Approve a publisher or enterprise repository
        </summary>
        <p className="mt-2 text-xs text-stone-500">
          Only enroll an origin and publisher you independently trust. A discovered website is not
          automatically authorized. Tokens are protected in local Windows storage and never sent to
          the model.
        </p>
        <form onSubmit={enroll} className="mt-3 space-y-3">
          <label className="block text-xs">
            Provider kind
            <select
              className={input}
              value={kind}
              onChange={(event) => setKind(event.target.value)}
            >
              {[
                'json-feed',
                'release-api',
                'local-repository',
                'official-page',
                'package-repository',
              ].map((value) => (
                <option key={value}>{value}</option>
              ))}
            </select>
          </label>
          {[
            ['Provider ID', sourceId, setSourceId],
            ['Display name', sourceName, setSourceName],
            ['Expected publishers (comma-separated)', publisher, setPublisher],
          ].map(([label, value, update]) => (
            <label key={label} className="block text-xs">
              {label}
              <input
                className={input}
                value={value}
                required
                maxLength={240}
                onChange={(event) => update(event.target.value)}
              />
            </label>
          ))}
          {kind === 'local-repository' ? (
            <>
              <p className="break-words text-xs">
                {directory || 'Select an approved local folder'}
              </p>
              <button
                type="button"
                className={button}
                onClick={() =>
                  act(async () => {
                    const result = await window.softwareAPI.pickDirectory();
                    if (!result.cancelled) setDirectory(result.directory);
                  })
                }
              >
                Choose installer folder
              </button>
            </>
          ) : (
            <>
              {[
                ['Approved HTTPS origin', origin, setOrigin],
                ['Allowed exact hosts (comma-separated)', hosts, setHosts],
              ].map(([label, value, update]) => (
                <label key={label} className="block text-xs">
                  {label}
                  <input
                    className={input}
                    value={value}
                    required
                    maxLength={2048}
                    onChange={(event) => update(event.target.value)}
                  />
                </label>
              ))}
              <label className="block text-xs">
                <input
                  type="checkbox"
                  checked={enterprise}
                  onChange={(event) => setEnterprise(event.target.checked)}
                />{' '}
                Explicit enterprise private network source
              </label>
            </>
          )}
          {['json-feed', 'release-api'].includes(kind) && (
            <>
              <label className="block text-xs">
                Authorized metadata API URL
                <input
                  className={input}
                  value={metadataUrl}
                  required
                  maxLength={2048}
                  onChange={(event) => setMetadataUrl(event.target.value)}
                />
              </label>
              <label className="block text-xs">
                API bearer token (optional)
                <input
                  type="password"
                  autoComplete="off"
                  className={input}
                  value={credential}
                  maxLength={8192}
                  onChange={(event) => setCredential(event.target.value)}
                />
              </label>
            </>
          )}
          {kind === 'release-api' && (
            <>
              {[
                ['Official product ID', releaseProductId, setReleaseProductId],
                ['Official product name', releaseProductName, setReleaseProductName],
              ].map(([label, value, update]) => (
                <label key={label} className="block text-xs">
                  {label}
                  <input
                    className={input}
                    value={value}
                    required
                    onChange={(event) => update(event.target.value)}
                  />
                </label>
              ))}
            </>
          )}
          {kind === 'package-repository' && (
            <label className="block text-xs">
              Configured repository name (optional)
              <input
                className={input}
                value={repository}
                onChange={(event) => setRepository(event.target.value)}
              />
            </label>
          )}
          <button className={button} disabled={busy || (kind === 'local-repository' && !directory)}>
            Review source authorization
          </button>
        </form>
      </details>
      {providers?.sources?.length > 0 && (
        <section className="space-y-2">
          <h4 className="font-medium">Approved sources in this account</h4>
          {providers.sources.map((source) => (
            <div key={source.registrationId} className="rounded-lg border border-white/10 p-3">
              <p className="text-xs">
                {source.descriptor.name} · {source.descriptor.publishers.join(', ')}
                {source.authenticated ? ' · credential protected' : ''}
              </p>
              <button
                type="button"
                className={`${button} mt-2`}
                disabled={busy}
                onClick={() =>
                  act(async () =>
                    receive(await window.softwareAPI.removeSource(source.registrationId)),
                  )
                }
              >
                Review disabling source
              </button>
            </div>
          ))}
        </section>
      )}
    </div>
  );
}
