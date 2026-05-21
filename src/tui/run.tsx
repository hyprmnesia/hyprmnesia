import { render } from 'ink'
import { App } from './App'
import { makeRemoteOrchestrator } from './remoteOrchestrator'

export async function runTui(): Promise<void> {
  const orch = makeRemoteOrchestrator()
  const instance = render(<App orch={orch} />)
  const cleanup = () => {
    orch.dispose?.()
    instance.unmount()
  }
  process.once('SIGTERM', cleanup)
  await instance.waitUntilExit()
}
