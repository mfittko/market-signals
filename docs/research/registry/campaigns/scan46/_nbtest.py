import numba, numpy
print(numba.__version__, numpy.__version__)
@numba.njit
def f(x):
    return x.sum()
print(f(numpy.ones(3)))
