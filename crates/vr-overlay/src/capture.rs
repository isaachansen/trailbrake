//! Windows Graphics Capture of the overlay window.
//!
//! We capture the whole transparent overlay window into a D3D11 texture, copy it
//! to a CPU-readable staging texture, and hand the BGRA bytes to the render loop
//! (which crops out each widget). WGC captures the composited window — including
//! its alpha — so panels keep their translucency. (One caveat: CSS
//! `backdrop-filter` blur samples whatever is behind the window on the *desktop*,
//! not the cockpit, so heavy blur looks odd in VR — prefer higher panel opacity.)
//!
//! The capturer is created and used entirely on the render thread because the
//! `windows` COM wrappers are `!Send`.

#![allow(dead_code)] // Some helpers are only exercised by the real backends.

use windows::core::Interface;
use windows::Graphics::Capture::{
    Direct3D11CaptureFramePool, GraphicsCaptureItem, GraphicsCaptureSession,
};
use windows::Graphics::DirectX::DirectXPixelFormat;
use windows::Graphics::DirectX::Direct3D11::IDirect3DDevice;
use windows::Graphics::SizeInt32;
use windows::Win32::Foundation::HWND;
use windows::Win32::Graphics::Direct3D::{D3D_DRIVER_TYPE_HARDWARE, D3D_DRIVER_TYPE_WARP};
use windows::Win32::Graphics::Direct3D11::{
    D3D11CreateDevice, ID3D11Device, ID3D11DeviceContext, ID3D11Texture2D,
    D3D11_CPU_ACCESS_READ, D3D11_CREATE_DEVICE_BGRA_SUPPORT, D3D11_MAPPED_SUBRESOURCE,
    D3D11_MAP_READ, D3D11_SDK_VERSION, D3D11_TEXTURE2D_DESC, D3D11_USAGE_STAGING,
};
use windows::Win32::Graphics::Dxgi::Common::DXGI_SAMPLE_DESC;
use windows::Win32::Graphics::Dxgi::IDXGIDevice;
use windows::Win32::System::Com::CoIncrementMTAUsage;
use windows::Win32::System::WinRT::Direct3D11::{
    CreateDirect3D11DeviceFromDXGIDevice, IDirect3DDxgiInterfaceAccess,
};
use windows::Win32::System::WinRT::Graphics::Capture::IGraphicsCaptureItemInterop;

use crate::VrError;

/// A captured frame in BGRA8, tightly packed (`width*height*4` bytes, top-down).
pub struct Frame {
    pub width: u32,
    pub height: u32,
    pub data: Vec<u8>,
}

pub struct Capturer {
    device: ID3D11Device,
    context: ID3D11DeviceContext,
    _item: GraphicsCaptureItem,
    pool: Direct3D11CaptureFramePool,
    session: GraphicsCaptureSession,
    staging: Option<(ID3D11Texture2D, u32, u32)>,
}

fn win<T>(r: windows::core::Result<T>) -> Result<T, VrError> {
    r.map_err(|e| VrError::Runtime(format!("WGC: {e}")))
}

impl Capturer {
    pub fn new(hwnd: isize) -> Result<Self, VrError> {
        if hwnd == 0 {
            return Err(VrError::Runtime("overlay window handle is null".into()));
        }
        // Ensure a process-wide MTA exists for the WinRT capture objects without
        // pinning this thread to an apartment.
        unsafe {
            let _ = CoIncrementMTAUsage();
        }

        let (device, context) = create_d3d_device()?;
        let d3d_device = create_winrt_device(&device)?;

        // GraphicsCaptureItem from the HWND via the interop factory.
        let interop: IGraphicsCaptureItemInterop =
            win(windows::core::factory::<GraphicsCaptureItem, IGraphicsCaptureItemInterop>())?;
        let item: GraphicsCaptureItem = win(unsafe { interop.CreateForWindow(HWND(hwnd as _)) })?;
        let size: SizeInt32 = win(item.Size())?;

        let pool = win(Direct3D11CaptureFramePool::CreateFreeThreaded(
            &d3d_device,
            DirectXPixelFormat::B8G8R8A8UIntNormalized,
            2,
            size,
        ))?;
        let session = win(pool.CreateCaptureSession(&item))?;
        // Cosmetic niceties; ignore if the OS build doesn't support them.
        let _ = session.SetIsCursorCaptureEnabled(false);
        let _ = session.SetIsBorderRequired(false);
        win(session.StartCapture())?;

        Ok(Self {
            device,
            context,
            _item: item,
            pool,
            session,
            staging: None,
        })
    }

    /// Pull the most recent frame, or `Ok(None)` if none is ready this tick.
    pub fn frame(&mut self) -> Result<Option<Frame>, VrError> {
        // Drain to the newest frame so we don't lag behind.
        let mut latest = None;
        while let Ok(f) = self.pool.TryGetNextFrame() {
            latest = Some(f);
        }
        let frame = match latest {
            Some(f) => f,
            None => return Ok(None),
        };

        let surface = win(frame.Surface())?;
        let access: IDirect3DDxgiInterfaceAccess = win(surface.cast())?;
        let tex: ID3D11Texture2D = win(unsafe { access.GetInterface() })?;

        let mut desc = D3D11_TEXTURE2D_DESC::default();
        unsafe { tex.GetDesc(&mut desc) };
        let (w, h) = (desc.Width, desc.Height);

        self.ensure_staging(&desc, w, h)?;
        let staging = self.staging.as_ref().map(|(t, _, _)| t.clone()).unwrap();

        unsafe {
            self.context.CopyResource(&staging, &tex);
            let mut mapped = D3D11_MAPPED_SUBRESOURCE::default();
            win(self
                .context
                .Map(&staging, 0, D3D11_MAP_READ, 0, Some(&mut mapped)))?;

            let row_bytes = (w * 4) as usize;
            let mut data = vec![0u8; row_bytes * h as usize];
            let src = mapped.pData as *const u8;
            let pitch = mapped.RowPitch as usize;
            for y in 0..h as usize {
                let s = src.add(y * pitch);
                let d = data.as_mut_ptr().add(y * row_bytes);
                std::ptr::copy_nonoverlapping(s, d, row_bytes);
            }
            self.context.Unmap(&staging, 0);

            Ok(Some(Frame {
                width: w,
                height: h,
                data,
            }))
        }
    }

    fn ensure_staging(
        &mut self,
        src_desc: &D3D11_TEXTURE2D_DESC,
        w: u32,
        h: u32,
    ) -> Result<(), VrError> {
        if let Some((_, sw, sh)) = &self.staging {
            if *sw == w && *sh == h {
                return Ok(());
            }
        }
        let desc = D3D11_TEXTURE2D_DESC {
            Width: w,
            Height: h,
            MipLevels: 1,
            ArraySize: 1,
            Format: src_desc.Format,
            SampleDesc: DXGI_SAMPLE_DESC {
                Count: 1,
                Quality: 0,
            },
            Usage: D3D11_USAGE_STAGING,
            BindFlags: 0,
            CPUAccessFlags: D3D11_CPU_ACCESS_READ.0 as u32,
            MiscFlags: 0,
        };
        let mut tex: Option<ID3D11Texture2D> = None;
        win(unsafe { self.device.CreateTexture2D(&desc, None, Some(&mut tex)) })?;
        self.staging = Some((
            tex.ok_or_else(|| VrError::Runtime("CreateTexture2D returned null".into()))?,
            w,
            h,
        ));
        Ok(())
    }
}

impl Drop for Capturer {
    fn drop(&mut self) {
        let _ = self.session.Close();
        let _ = self.pool.Close();
    }
}

/// Create a hardware D3D11 device (falling back to WARP), with BGRA support for
/// interop with the WinRT capture surface.
fn create_d3d_device() -> Result<(ID3D11Device, ID3D11DeviceContext), VrError> {
    for driver in [D3D_DRIVER_TYPE_HARDWARE, D3D_DRIVER_TYPE_WARP] {
        let mut device: Option<ID3D11Device> = None;
        let mut context: Option<ID3D11DeviceContext> = None;
        let hr = unsafe {
            D3D11CreateDevice(
                None,
                driver,
                Default::default(),
                D3D11_CREATE_DEVICE_BGRA_SUPPORT,
                None,
                D3D11_SDK_VERSION,
                Some(&mut device),
                None,
                Some(&mut context),
            )
        };
        if hr.is_ok() {
            if let (Some(d), Some(c)) = (device, context) {
                return Ok((d, c));
            }
        }
    }
    Err(VrError::Runtime("failed to create D3D11 device".into()))
}

/// Wrap a D3D11 device as a WinRT `IDirect3DDevice` for the capture frame pool.
fn create_winrt_device(device: &ID3D11Device) -> Result<IDirect3DDevice, VrError> {
    let dxgi: IDXGIDevice = win(device.cast())?;
    let inspectable = win(unsafe { CreateDirect3D11DeviceFromDXGIDevice(&dxgi) })?;
    win(inspectable.cast())
}
