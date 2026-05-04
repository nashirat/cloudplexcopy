import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import './index.css'
import App from './App.jsx'
import IglooPage from './IglooPage.jsx'
import Igloo2Page from './Igloo2Page.jsx'
import Ktx2Viewer from './Ktx2Viewer.jsx'
import WaterPage from './WaterPage.jsx'
import LatestWaterPage from './latestwater/LatestWaterPage.jsx'
import WaterDone1Page from './WaterDone1Page.jsx'
import RealBlurPage from './RealBlurPage.jsx'
import WaterSmallPage from './WaterSmallPage.jsx'

const path = window.location.pathname
const isHomeRoute = path === '/'
const isIgloo2Route = path === '/igloo2' || path.startsWith('/igloo2/')
const isIglooRoute = path === '/igloo' || path.startsWith('/igloo/')
const isKtx2Route = path === '/ktx2viewer' || path.startsWith('/ktx2viewer/')
const isWaterRoute = path === '/water' || path.startsWith('/water/')
const isLatestWaterRoute = path === '/latestwater' || path.startsWith('/latestwater/')
const isWaterDone1Route = path === '/waterdone1' || path.startsWith('/waterdone1/')
const isRealBlurRoute = path === '/realblur' || path.startsWith('/realblur/')
const isWaterSmallRoute = path === '/watersmall' || path.startsWith('/watersmall/')

const RootComponent = isHomeRoute
  ? WaterDone1Page
  : isKtx2Route
  ? Ktx2Viewer
  : isWaterSmallRoute
    ? WaterSmallPage
  : isRealBlurRoute
    ? RealBlurPage
  : isWaterDone1Route
    ? WaterDone1Page
  : isLatestWaterRoute
    ? LatestWaterPage
  : isWaterRoute
    ? WaterPage
  : isIgloo2Route
    ? Igloo2Page
    : isIglooRoute
      ? IglooPage
      : App

createRoot(document.getElementById('root')).render(
  <StrictMode>
    <RootComponent />
  </StrictMode>,
)
