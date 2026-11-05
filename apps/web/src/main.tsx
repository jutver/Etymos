import { StrictMode, Suspense } from 'react'
import { createRoot } from 'react-dom/client'
import { BrowserRouter } from 'react-router-dom'
import { LazyMotion } from 'motion/react'
import './styles/globals.css'
import './styles/editorial.css'
import App from './App.tsx'
import { AuthProvider } from './lib/auth'
import { PageLoader } from './components/ui/PageLoader'
import { SplashProvider } from './components/BootSplash'

// Motion's animation engine downloads on its own, after the app starts.
const loadMotionFeatures = () => import('./lib/motionFeatures').then((mod) => mod.default)

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    {/* strict: a stray motion.* (which would pull the whole engine back into
        the first download) throws in development instead of slipping by. */}
    <LazyMotion features={loadMotionFeatures} strict>
    <BrowserRouter>
      <AuthProvider>
        <SplashProvider>
          {/* Safety net: the per-shell boundaries handle normal route
              transitions, this catches anything lazy mounted outside a shell. */}
          <Suspense fallback={<PageLoader />}>
            <App />
          </Suspense>
        </SplashProvider>
      </AuthProvider>
    </BrowserRouter>
    </LazyMotion>
  </StrictMode>,
)
