use ndarray::ArrayView1;

#[inline]
pub fn l2_dist_sq(a: ArrayView1<'_, f32>, b: ArrayView1<'_, f32>) -> f32 {
  if let (Some(a_s), Some(b_s)) = (a.as_slice(), b.as_slice()) {
    return l2_dist_sq_slice(a_s, b_s);
  }
  l2_dist_sq_scalar_iter(a.iter().copied(), b.iter().copied())
}

#[inline]
fn l2_dist_sq_scalar_iter<I, J>(a: I, b: J) -> f32
where
  I: Iterator<Item = f32>,
  J: Iterator<Item = f32>,
{
  a.zip(b)
    .map(|(x, y)| {
      let d = x - y;
      d * d
    })
    .sum()
}

#[inline]
fn l2_dist_sq_slice(a: &[f32], b: &[f32]) -> f32 {
  debug_assert_eq!(a.len(), b.len());

  #[cfg(all(target_arch = "x86_64", target_feature = "avx2"))]
  {
    return unsafe { l2_dist_sq_avx2(a, b) };
  }

  #[cfg(all(target_arch = "aarch64", target_feature = "neon"))]
  {
    return unsafe { l2_dist_sq_neon(a, b) };
  }

  #[cfg(not(any(
    all(target_arch = "x86_64", target_feature = "avx2"),
    all(target_arch = "aarch64", target_feature = "neon"),
  )))]
  l2_dist_sq_scalar_iter(a.iter().copied(), b.iter().copied())
}

#[cfg(all(target_arch = "x86_64", target_feature = "avx2"))]
#[inline]
unsafe fn l2_dist_sq_avx2(a: &[f32], b: &[f32]) -> f32 {
  use core::arch::x86_64::*;

  let mut i = 0usize;
  let mut acc = _mm256_setzero_ps();
  while i + 8 <= a.len() {
    let va = _mm256_loadu_ps(a.as_ptr().add(i));
    let vb = _mm256_loadu_ps(b.as_ptr().add(i));
    let d = _mm256_sub_ps(va, vb);
    acc = _mm256_add_ps(acc, _mm256_mul_ps(d, d));
    i += 8;
  }

  let mut lanes = [0f32; 8];
  _mm256_storeu_ps(lanes.as_mut_ptr(), acc);
  let mut sum = lanes.iter().sum::<f32>();
  while i < a.len() {
    let d = a[i] - b[i];
    sum += d * d;
    i += 1;
  }
  sum
}

#[cfg(all(target_arch = "aarch64", target_feature = "neon"))]
#[inline]
unsafe fn l2_dist_sq_neon(a: &[f32], b: &[f32]) -> f32 {
  use core::arch::aarch64::*;

  let mut i = 0usize;
  let mut acc = vdupq_n_f32(0.0);
  while i + 4 <= a.len() {
    let va = vld1q_f32(a.as_ptr().add(i));
    let vb = vld1q_f32(b.as_ptr().add(i));
    let d = vsubq_f32(va, vb);
    acc = vfmaq_f32(acc, d, d);
    i += 4;
  }

  let mut sum = vaddvq_f32(acc);
  while i < a.len() {
    let d = a[i] - b[i];
    sum += d * d;
    i += 1;
  }
  sum
}

#[inline]
pub fn l2_dist(a: ArrayView1<'_, f32>, b: ArrayView1<'_, f32>) -> f32 {
  l2_dist_sq(a, b).sqrt()
}

#[inline]
pub fn dist_bits(d: f32) -> u32 {
  d.to_bits()
}
