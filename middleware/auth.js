const jwt = require('jsonwebtoken');

function authenticateToken(req, res, next) {
  const authHeader = req.headers['authorization'];
  const token = authHeader && authHeader.split(' ')[1];
  if (!token) return res.status(401).json({ code: 'TOKEN_REQUIRED', message: 'جلسة الدخول مطلوبة' });

  jwt.verify(token, process.env.JWT_SECRET, (err, user) => {
    if (err) {
      if (err.name === 'TokenExpiredError') {
        return res.status(401).json({ code: 'TOKEN_EXPIRED', message: 'انتهت جلسة الدخول' });
      }
      return res.status(403).json({ code: 'TOKEN_INVALID', message: 'جلسة الدخول غير صالحة' });
    }
    if (user.tokenType === 'refresh') {
      return res.status(403).json({ code: 'TOKEN_INVALID', message: 'رمز الجلسة غير صالح لهذا الطلب' });
    }
    req.user = user;
    next();
  });
}

module.exports = authenticateToken;
