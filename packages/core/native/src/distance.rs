use ndarray::ArrayView1;

#[inline]
pub fn l2_dist_sq(a: ArrayView1<'_, f32>, b: ArrayView1<'_, f32>) -> f32 {
  a.iter()
    .zip(b.iter())
    .map(|(x, y)| {
      let d = x - y;
      d * d
    })
    .sum()
}

#[inline]
pub fn l2_dist(a: ArrayView1<'_, f32>, b: ArrayView1<'_, f32>) -> f32 {
  l2_dist_sq(a, b).sqrt()
}

#[inline]
pub fn dist_bits(d: f32) -> u32 {
  d.to_bits()
}
